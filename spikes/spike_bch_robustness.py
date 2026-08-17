# Spike: codec v2 (BCH) end-to-end on the real VideoSeal channel.
# Same transcode ladder as spike_robustness.py, but the embedded message is a
# codec_v2 payload (proofId + pHash) and success = exact payload recovery.
import json
import os
import subprocess
import sys

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'videoseal'))

import videoseal  # noqa: E402
from inference_streaming import embed_video, detect_video  # noqa: E402

import codec_v2  # noqa: E402
from spike_robustness import CONDITIONS  # noqa: E402

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, 'videoseal', 'assets', 'videos', '1.mp4')
OUT = os.path.join(BASE, 'results')
WM = os.path.join(OUT, 'watermarked_v2.mp4')

PROOF_ID = (0x2A5 << 14) | 1234  # arbitrary deviceId=677, counter=1234
PHASH = 0x0123456789ABCDEF0123456789  # arbitrary 104-bit stand-in


def main():
    os.makedirs(OUT, exist_ok=True)
    model = videoseal.load('videoseal')
    model.eval()

    msg = codec_v2.encode(PROOF_ID, PHASH)
    # embed_video draws its message from get_random_msg — inject ours
    model.get_random_msg = lambda *a, **k: msg

    embed_video(model, SRC, WM, chunk_size=16, crf=18)
    results = {}

    def check(name, path):
        soft = detect_video(model, path, chunk_size=16)
        avg = soft.mean(dim=0) if soft.dim() > 1 else soft
        # logits are centered on 0.5 in [0,1] space at this layer? decode
        # thresholds at 0 — shift if the extractor emits probabilities
        if avg.min() >= 0:
            avg = avg - 0.5
        got_id, got_hash, nflips = codec_v2.decode(avg)
        ok = got_id == PROOF_ID and got_hash == PHASH
        hard = (avg > 0).float()
        wrong = int((hard != msg[0]).sum().item())
        results[name] = {'decoded': ok, 'wrong_bits_of_256': wrong,
                         'bch_corrected': nflips}
        print(f'{name}: decoded={ok} wrong_bits={wrong} corrected={nflips}')

    check('baseline_no_transcode', WM)
    for name, args in CONDITIONS.items():
        dst = os.path.join(OUT, f'v2_{name}.mp4')
        subprocess.run(['ffmpeg', '-y', '-i', WM] + args + ['-an', dst],
                       check=True, capture_output=True)
        check(name, dst)
        os.remove(dst)

    with open(os.path.join(OUT, 'bch_robustness.json'), 'w') as f:
        json.dump(results, f, indent=2)
    print('saved results/bch_robustness.json')


if __name__ == '__main__':
    main()
