# Payload codec v3 for the 256-bit VideoSeal message.
# Layout: 128 data bits (captureId, random UUID) + 124 BCH parity + 4 zero pad.
# Same BCH(255,131,t=18) geometry as v2 — the data block is already 16 bytes,
# so the v2 basis matrix and all wire conventions carry over unchanged.
import bchlib
import torch

BCH_T = 18
DATA_BYTES = 16
BITS = 256

_bch = bchlib.BCH(BCH_T, m=8)
ECC_BITS = _bch.ecc_bits  # 124 — trailing 20 bits of bchlib's ecc buffer are always zero
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


def encode(capture_id: bytes) -> torch.Tensor:
    assert len(capture_id) == DATA_BYTES and any(capture_id)
    ecc = _bch.encode(capture_id)
    bits = _to_bits(capture_id) + _to_bits(ecc)[:ECC_BITS]
    bits += [0] * (BITS - len(bits))
    return torch.tensor(bits, dtype=torch.float32).unsqueeze(0)  # (1, 256)


def decode(soft_bits: torch.Tensor):
    """soft_bits: (256,) logits. Returns (capture_id bytes, corrected) or (None, None)."""
    hard = (soft_bits > 0).long().tolist()
    data = bytearray(_to_bytes(hard[:DATA_BYTES * 8]))
    ecc_bits = hard[DATA_BYTES * 8:CODED_BITS] + [0] * (_bch.ecc_bytes * 8 - ECC_BITS)
    ecc = bytearray(_to_bytes(ecc_bits))
    nflips = _bch.decode(data, ecc)
    if nflips < 0:
        return None, None
    _bch.correct(data, ecc)
    if not any(data):  # all-zero id is reserved/invalid
        return None, None
    return bytes(data), nflips
