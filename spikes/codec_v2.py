# Payload codec v2 for the 256-bit VideoSeal message (exploration, branch only).
# Layout: 128 data bits (proofId 24 | pHash 104) + 124 BCH parity + 4 zero pad.
# BCH(255,131,t=18) — bchlib caps byte-aligned data at 16 bytes, so 128 info bits.
# Corrects up to 18 wrong bits anywhere in the 252 coded bits; phase-0 worst
# measured channel error was 13/256 (stress 360p ladder).
import bchlib
import torch

BCH_T = 18
DATA_BYTES = 16
PHASH_BITS = 104
BITS = 256
MAX_ID = 2 ** 24

_bch = bchlib.BCH(BCH_T, m=8)
ECC_BITS = _bch.ecc_bits  # 124 — bchlib pads its ecc buffer to 18 bytes, the
# trailing 20 bits are always zero, so only 124 go on the wire
CODED_BITS = DATA_BYTES * 8 + ECC_BITS  # 252


def _to_bits(data: bytes):
    return [(byte >> s) & 1 for byte in data for s in range(7, -1, -1)]


def _to_bytes(bits):
    out = bytearray()
    for i in range(0, len(bits), 8):
        byte = 0
        for b in bits[i:i + 8]:
            byte = (byte << 1) | b
        out.append(byte)
    return bytes(out)


def encode(proof_id: int, phash: int) -> torch.Tensor:
    assert 0 < proof_id < MAX_ID
    assert 0 <= phash < 2 ** PHASH_BITS
    data = ((proof_id << PHASH_BITS) | phash).to_bytes(DATA_BYTES, 'big')
    ecc = _bch.encode(data)
    bits = _to_bits(data) + _to_bits(ecc)[:ECC_BITS]
    bits += [0] * (BITS - len(bits))
    return torch.tensor(bits, dtype=torch.float32).unsqueeze(0)  # (1, 256)


def decode(soft_bits: torch.Tensor):
    """soft_bits: (256,) logits (already averaged across frames).
    Returns (proof_id, phash, corrected_bits) or (None, None, None)."""
    hard = (soft_bits > 0).long().tolist()
    data = bytearray(_to_bytes(hard[:DATA_BYTES * 8]))
    ecc_bits = hard[DATA_BYTES * 8:CODED_BITS] + [0] * (_bch.ecc_bytes * 8 - ECC_BITS)
    ecc = bytearray(_to_bytes(ecc_bits))
    nflips = _bch.decode(data, ecc)
    if nflips < 0:
        return None, None, None
    _bch.correct(data, ecc)
    value = int.from_bytes(bytes(data), 'big')
    proof_id = value >> PHASH_BITS
    phash = value & (2 ** PHASH_BITS - 1)
    if proof_id == 0:
        return None, None, None
    return proof_id, phash, nflips
