# Payload codec for the 256-bit VideoSeal message.
# Layout: (proof_id 24 bit || crc8) = 32 bits, repeated 8x = 256 bits.
# Copies of each bit sit 32 positions apart: a contiguous error burst (< 32 bits)
# hits at most one copy per payload bit; a column only fails with >= 4/8 copies
# flipped. Survives well beyond the error rates measured in phase 0 (13/256 worst).
import torch

BLOCK = 32
REPS = 8
BITS = 256
MAX_ID = 2 ** 24  # proof ids must stay below 16.7M


def _pos(r, i):
    return r * BLOCK + i


def crc8(data: int) -> int:
    # CRC-8 (poly 0x07) over the 3 id bytes
    crc = 0
    for shift in (16, 8, 0):
        crc ^= (data >> shift) & 0xFF
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) if crc & 0x80 else (crc << 1)
            crc &= 0xFF
    return crc


def encode(proof_id: int) -> torch.Tensor:
    assert 0 < proof_id < MAX_ID
    block = (proof_id << 8) | crc8(proof_id)  # 32 bits
    msg = [0.0] * BITS
    for i in range(BLOCK):
        bit = (block >> (BLOCK - 1 - i)) & 1
        for r in range(REPS):
            msg[_pos(r, i)] = float(bit)
    return torch.tensor(msg, dtype=torch.float32).unsqueeze(0)  # (1, 256)


def decode(soft_bits: torch.Tensor):
    """soft_bits: (256,) logits from the extractor (already averaged across frames).
    Returns (proof_id, confidence) or (None, agreement) if CRC fails."""
    combined = torch.tensor([
        sum(soft_bits[_pos(r, i)].item() for r in range(REPS)) for i in range(BLOCK)
    ])
    bits = (combined > 0).long().tolist()
    block = 0
    for b in bits:
        block = (block << 1) | b
    proof_id, crc = block >> 8, block & 0xFF
    # Agreement: fraction of repetition copies matching the combined decision
    agree = 0
    for i in range(BLOCK):
        for r in range(REPS):
            agree += int((soft_bits[_pos(r, i)].item() > 0) == (combined[i].item() > 0))
    agreement = agree / (BLOCK * REPS)
    if crc8(proof_id) != crc or proof_id == 0:
        return None, agreement
    return proof_id, agreement
