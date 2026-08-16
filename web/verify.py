#!/usr/bin/env python3
"""TrustCam command-line verifier — fully local, nothing is uploaded.

    python3 verify.py photo.jpg            # proof-trailer check (needs only openssl)
    python3 verify.py --scan video.mp4     # + invisible-mark scan when no trailer
                                           #   (needs: pip install onnxruntime pillow;
                                           #    videos also need ffmpeg)

Verdicts mirror the web verifier: VERIFIED (exact file, seal valid),
ORIGIN TRACED (invisible mark only — origin, never integrity), NO PROOF.
"""
import base64
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import urllib.request

BASE = os.environ.get('TRUSTCAM_URL', 'https://trustcam.gregoriogalante.com')
MAGIC = b'TCPROOF1'

# --- payload codec (must stay bit-identical to spikes/codec.py) ---
BLOCK, REPS = 32, 8


def crc8(data):
    crc = 0
    for shift in (16, 8, 0):
        crc ^= (data >> shift) & 0xFF
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) if crc & 0x80 else (crc << 1)
            crc &= 0xFF
    return crc


def decode_bits(soft):
    combined = [sum(soft[r * BLOCK + i] for r in range(REPS)) for i in range(BLOCK)]
    block = 0
    for c in combined:
        block = (block << 1) | (1 if c > 0 else 0)
    payload, crc = block >> 8, block & 0xFF
    agree = sum((soft[r * BLOCK + i] > 0) == (combined[i] > 0)
                for i in range(BLOCK) for r in range(REPS))
    conf = agree / (BLOCK * REPS)
    if crc8(payload) != crc or payload == 0:
        return None, conf
    return payload, conf


# --- proof trailer ---
def parse_trailer(data):
    if len(data) < 20 or data[-8:] != MAGIC:
        return None
    (jlen,) = struct.unpack('>I', data[-12:-8])
    if jlen <= 0 or jlen > len(data) - 20:
        return None
    try:
        proof = json.loads(data[-12 - jlen:-12])
        return proof, len(data) - 20 - jlen
    except ValueError:
        return None


def verify_seal(data, proof, canonical_end):
    h = hashlib.sha256(data[:canonical_end]).digest()
    with tempfile.TemporaryDirectory() as td:
        der = os.path.join(td, 'key.der')
        pem = os.path.join(td, 'key.pem')
        sig = os.path.join(td, 'sig.der')
        msg = os.path.join(td, 'hash.bin')
        open(der, 'wb').write(base64.b64decode(proof['pubkey']))
        open(sig, 'wb').write(base64.b64decode(proof['sig']))
        open(msg, 'wb').write(h)
        subprocess.run(['openssl', 'pkey', '-pubin', '-inform', 'DER', '-in', der, '-out', pem],
                       check=True, capture_output=True)
        res = subprocess.run(['openssl', 'dgst', '-sha256', '-verify', pem, '-signature', sig, msg],
                             capture_output=True)
    attested = False
    chain = proof.get('attestation') or []
    if chain:
        attested = base64.b64decode(proof['pubkey']) in base64.b64decode(chain[0])
    return res.returncode == 0, attested, h.hex()


# --- invisible-mark scan (optional deps) ---
def detector_path():
    cache = os.path.join(os.path.expanduser('~'), '.cache', 'trustcam')
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, 'detector.onnx')
    if not os.path.exists(path):
        print(f'downloading detector model (~34MB) from {BASE} …', file=sys.stderr)
        urllib.request.urlretrieve(f'{BASE}/models/detector.onnx', path)
    return path


def soft_bits(session, img):
    import numpy as np
    img.thumbnail((1536, 1536))
    x = np.asarray(img.convert('RGB')).astype('float32').transpose(2, 0, 1)[None] / 255.0
    return session.run(None, {'image': x})[0][0, 1:]


def scan_marks(path):
    try:
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
    except ImportError:
        sys.exit('the mark scan needs: pip install onnxruntime pillow numpy')
    session = ort.InferenceSession(detector_path())

    if os.path.splitext(path)[1].lower() in ('.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'):
        with tempfile.TemporaryDirectory() as td:
            try:
                dur = float(subprocess.run(
                    ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                     '-of', 'csv=p=0', path], capture_output=True, text=True, check=True
                ).stdout.strip())
            except (FileNotFoundError, subprocess.CalledProcessError):
                sys.exit('video scan needs ffmpeg/ffprobe installed')
            n = 32
            subprocess.run(
                ['ffmpeg', '-v', 'error', '-i', path, '-vf',
                 f"fps={max(n / max(dur, 0.1), 0.1)},scale='min(1536,iw)':-2",
                 '-frames:v', str(n), os.path.join(td, 'f_%03d.jpg')],
                check=True, capture_output=True)
            frames = sorted(os.listdir(td))
            if not frames:
                sys.exit('no frames decoded')
            acc = np.zeros(256, dtype='float64')
            for f in frames:
                acc += soft_bits(session, Image.open(os.path.join(td, f)))
            return decode_bits(acc / len(frames))
    return decode_bits(soft_bits(session, Image.open(path)))


def registry_name(payload):
    try:
        with urllib.request.urlopen(f'{BASE}/registry.json', timeout=10) as r:
            reg = json.load(r)
        return reg.get('devices', {}).get(str(payload // 16384))
    except OSError:
        return None


def main():
    args = sys.argv[1:]
    scan = '--scan' in args
    args = [a for a in args if a != '--scan']
    if len(args) != 1 or not os.path.isfile(args[0]):
        sys.exit(__doc__)
    path = args[0]
    data = open(path, 'rb').read()

    t = parse_trailer(data)
    if t:
        proof, canonical_end = t
        ok, attested, fingerprint = verify_seal(data, proof, canonical_end)
        payload = proof.get('payload', 0)
        if ok:
            print('VERIFIED — exact file, seal valid. Untouched since capture.')
        else:
            print('INVALID — the file carries a proof but the seal does NOT check out. Untrusted.')
        print(f"  recorded by : {proof.get('name')}")
        print(f"  device      : {proof.get('model')} ({proof.get('securityLevel')}"
              f"{', hardware-attested key' if attested else ''})")
        print(f"  captured at : {proof.get('capturedAt')} (device-claimed)")
        print(f"  mark id     : device #{payload // 16384} · capture #{payload % 16384}")
        print(f"  fingerprint : {fingerprint}")
        sys.exit(0 if ok else 1)

    if not scan:
        print('NO PROOF TRAILER — if this copy was re-encoded by a platform,')
        print('re-run with --scan to look for the invisible mark in the pixels.')
        sys.exit(1)

    payload, conf = scan_marks(path)
    if payload is None:
        print(f'NO PROOF — no invisible mark could be recovered (signal {conf:.0%}).')
        print('Never captured with TrustCam, or too little of the original is left.')
        sys.exit(1)
    entry = registry_name(payload)
    who = entry['name'] if entry else f'device #{payload // 16384} (not in the public registry)'
    print('ORIGIN TRACED — content NOT verified.')
    print(f'  this copy derives from a TrustCam capture by: {who}')
    print(f"  mark id     : device #{payload // 16384} · capture #{payload % 16384}")
    print(f'  mark signal : {conf:.0%} (decoding confidence, not authenticity)')
    print('  the copy was modified since capture (re-encode or edit — indistinguishable).')
    sys.exit(2)


if __name__ == '__main__':
    main()
