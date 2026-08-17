# Export parity vectors for the checksum feature ports:
# - codec v2: BCH encode basis matrix (Kotlin embeds it — XOR of rows equals
#   bchlib encode, no BCH math on device) + encode/decode cases incl. bit flips
#   (JS decoder must correct <=18 and cleanly reject beyond).
# - PDQ: formula-defined luma images -> expected 256-bit hash (bit k = DCT
#   coefficient (k//16, k%16) > median; note: the pdqhash python binding
#   returns bits REVERSED vs this order — pdq_ref.py is the canonical order).
# Output: results/checksum_vectors.json
import json
import os
import random

import numpy as np

import codec_v2
from pdq_ref import pdq_from_luma

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
random.seed(2026)


def bits_str(t):
    return ''.join(str(int(b > 0.5)) for b in t[0].tolist())


def bch_matrix():
    # ecc is linear in the data bits: ecc(data) = XOR of rows for set bits.
    # Row b = ecc of the 16-byte block with only bit b set (MSB-first).
    rows = []
    for b in range(128):
        data = (1 << (127 - b)).to_bytes(16, 'big')
        ecc = codec_v2._bch.encode(data)
        rows.append(int.from_bytes(ecc, 'big') >> (144 - 124))  # keep 124 bits
    # sanity: XOR-of-rows reproduces bchlib on random payloads
    for _ in range(200):
        value = random.getrandbits(128)
        want = int.from_bytes(
            codec_v2._bch.encode(value.to_bytes(16, 'big')), 'big') >> 20
        got = 0
        for b in range(128):
            if (value >> (127 - b)) & 1:
                got ^= rows[b]
        assert got == want, 'BCH linearity check failed'
    return ['%031x' % r for r in rows]


def codec_cases():
    cases = []
    for proof_id, phash in [
        (1, 0), ((0x2A5 << 14) | 1234, 0x0123456789ABCDEF0123456789),
        (0xFFFFFF, (1 << 104) - 1), (777, random.getrandbits(104)),
    ]:
        cases.append({'proofId': proof_id, 'phash': '%026x' % phash,
                      'bits': bits_str(codec_v2.encode(proof_id, phash))})
    return cases


def error_cases():
    cases = []
    for nflips in (0, 1, 5, 13, 18, 19, 25):
        for _ in range(4):
            proof_id = random.randrange(1, codec_v2.MAX_ID)
            phash = random.getrandbits(104)
            bits = list(bits_str(codec_v2.encode(proof_id, phash)))
            # flips only inside the 252 coded bits (pad bits are ignored)
            for p in random.sample(range(codec_v2.CODED_BITS), nflips):
                bits[p] = '1' if bits[p] == '0' else '0'
            ok = nflips <= codec_v2.BCH_T
            cases.append({'bits': ''.join(bits), 'flips': nflips,
                          'proofId': proof_id if ok else None,
                          'phash': '%026x' % phash if ok else None})
    return cases


# Formula luma images — ports regenerate these with the same integer formulas.
def formula_images():
    imgs = {}
    x, y = np.meshgrid(np.arange(640), np.arange(480))
    imgs['mix640x480'] = ((x * 7 + y * 13 + (x * y) % 31) % 256)
    x, y = np.meshgrid(np.arange(512), np.arange(512))
    imgs['grad512x512'] = ((x * 255 // 511) + (y * 255 // 511)) // 2
    x, y = np.meshgrid(np.arange(300), np.arange(200))
    imgs['blocks300x200'] = ((x // 25 + y // 25) % 2) * 200 + (x + y) % 55
    return {k: v.astype(np.float32) for k, v in imgs.items()}


def pdq_cases():
    cases = []
    for name, luma in formula_images().items():
        bits, quality = pdq_from_luma(luma)
        cases.append({'image': name, 'quality': quality,
                      'bits': ''.join(str(b) for b in bits)})
    return cases


def main():
    vectors = {
        'bchMatrix': bch_matrix(),
        'codecCases': codec_cases(),
        'errorCases': error_cases(),
        'pdqCases': pdq_cases(),
    }
    with open(os.path.join(OUT, 'checksum_vectors.json'), 'w') as f:
        json.dump(vectors, f, indent=1)
    print('saved results/checksum_vectors.json',
          f"({len(vectors['errorCases'])} error cases)")


if __name__ == '__main__':
    main()
