# Spike: BCH(255,131) codec v2 vs synthetic bit flips.
# Question: does the t=18 correction margin hold, and what happens beyond it
# (clean failure vs silent miscorrection)? Random and burst error patterns.
import json
import os
import random

import torch

import codec_v2

TRIALS = 500
MAX_FLIPS = 30
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')

random.seed(42)


def corrupt(msg_bits, positions):
    soft = [1.0 if b > 0.5 else -1.0 for b in msg_bits]
    for p in positions:
        soft[p] = -soft[p]
    return torch.tensor(soft)


def trial(nflips, burst):
    proof_id = random.randrange(1, codec_v2.MAX_ID)
    phash = random.getrandbits(codec_v2.PHASH_BITS)
    msg = codec_v2.encode(proof_id, phash)[0].tolist()
    # Flips land anywhere in the 256-bit message: pad bits can flip too,
    # mimicking the real channel (codec ignores them).
    if burst:
        start = random.randrange(0, codec_v2.BITS - nflips + 1)
        positions = range(start, start + nflips)
    else:
        positions = random.sample(range(codec_v2.BITS), nflips)
    # Flips inside the 252 coded bits are what BCH actually sees
    effective = sum(1 for p in positions if p < codec_v2.CODED_BITS)
    got_id, got_hash, _ = codec_v2.decode(corrupt(msg, positions))
    if got_id is None:
        return 'detected', effective
    if got_id == proof_id and got_hash == phash:
        return 'ok', effective
    return 'miscorrected', effective


def sweep(burst):
    rows = {}
    for nflips in range(0, MAX_FLIPS + 1):
        counts = {'ok': 0, 'detected': 0, 'miscorrected': 0}
        for _ in range(TRIALS):
            outcome, _ = trial(nflips, burst)
            counts[outcome] += 1
        rows[nflips] = counts
        if counts['miscorrected'] or counts['detected']:
            print(f"{'burst' if burst else 'random'} {nflips:2d}: {counts}")
    return rows


def main():
    results = {'trials': TRIALS, 'random': sweep(False), 'burst': sweep(True)}
    # Summary: highest flip count with 100% recovery
    for kind in ('random', 'burst'):
        ok_upto = max(k for k, c in results[kind].items() if c['ok'] == TRIALS)
        mis = sum(c['miscorrected'] for c in results[kind].values())
        print(f'{kind}: 100% recovery up to {ok_upto} flips, '
              f'{mis} miscorrections total across sweep')
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'bch_codec.json'), 'w') as f:
        json.dump(results, f, indent=2)
    print('saved results/bch_codec.json')


if __name__ == '__main__':
    main()
