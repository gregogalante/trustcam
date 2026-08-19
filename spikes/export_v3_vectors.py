# Exports parity vectors for the v3 payload codec (captureId 128 | BCH 124 |
# pad 4) so the Kotlin encoder and the JS decoder can be pinned bit-identical
# to the canonical python implementation. The BCH basis matrix is unchanged
# from v2 (the data block was already 16 bytes).
#   python export_v3_vectors.py   (from spikes/, videoseal conda env)
import json
import os
import random

import codec_v3

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'results', 'v3_vectors.json')

rng = random.Random(42)


def bits_str(t):
    return ''.join(str(int(b)) for b in t[0].tolist())


def rand_id():
    return bytes(rng.getrandbits(8) for _ in range(16))


cases = []
for cid in [bytes(15) + b'\x01', b'\xff' * 16, bytes.fromhex('0123456789abcdef0123456789abcdef'),
            rand_id(), rand_id()]:
    cases.append({'captureId': cid.hex(), 'bits': bits_str(codec_v3.encode(cid))})

error_cases = []
for flips in [1, 5, 12, 18, 19, 22]:
    cid = rand_id()
    bits = list(bits_str(codec_v3.encode(cid)))
    for pos in rng.sample(range(codec_v3.CODED_BITS), flips):
        bits[pos] = '0' if bits[pos] == '1' else '1'
    error_cases.append({'captureId': cid.hex(), 'flips': flips, 'bits': ''.join(bits)})

with open(OUT, 'w') as f:
    json.dump({'codecCases': cases, 'errorCases': error_cases}, f, indent=1)
print(f'wrote {OUT}: {len(cases)} codec cases, {len(error_cases)} error cases')
