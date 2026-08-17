# Pure-python PDQ reference — line-by-line port of the official C++
# (ThreatExchange pdq/cpp: downscaling.cpp, pdqhashing.cpp, torben.cpp).
# This file is the canonical source for the Kotlin (android Pdq.kt) and JS
# (web/js/pdq.js) ports: all three must produce (near-)identical bits.
# float32 throughout to mirror the C++; parity vs the pdqhash binding is
# asserted by spike_pdq_parity.py.
import numpy as np

REC601 = (0.299, 0.587, 0.114)


def _box1d(invec, outvec, n, full_window):
    half = (full_window + 2) // 2
    p1, p2 = half - 1, full_window - half + 1
    p3, p4 = n - full_window, half - 1
    li = ri = oi = 0
    s = np.float32(0.0)
    win = 0
    for _ in range(p1):
        s += invec[ri]
        win += 1
        ri += 1
    for _ in range(p2):
        s += invec[ri]
        win += 1
        outvec[oi] = s / np.float32(win)
        ri += 1
        oi += 1
    for _ in range(p3):
        s += invec[ri]
        s -= invec[li]
        outvec[oi] = s / np.float32(win)
        li += 1
        ri += 1
        oi += 1
    for _ in range(p4):
        s -= invec[li]
        win -= 1
        outvec[oi] = s / np.float32(win)
        li += 1
        oi += 1


def _jarosz(buf, rows, cols, wrow, wcol, nreps=2):
    tmp = np.empty_like(buf)
    for _ in range(nreps):
        for i in range(rows):  # box along rows
            _box1d(buf[i], tmp[i], cols, wrow)
        for j in range(cols):  # box along cols
            col_in = tmp[:, j].copy()
            col_out = np.empty(rows, dtype=np.float32)
            _box1d(col_in, col_out, rows, wcol)
            buf[:, j] = col_out
    return buf


def _decimate(buf, rows, cols):
    out = np.empty((64, 64), dtype=np.float32)
    for oi in range(64):
        ii = int(((oi + 0.5) * rows) / 64)
        for oj in range(64):
            jj = int(((oj + 0.5) * cols) / 64)
            out[oi, oj] = buf[ii, jj]
    return out


_D = None


def _dct_matrix():
    global _D
    if _D is None:
        scale = np.float32(np.sqrt(2.0 / 64.0))
        _D = np.empty((16, 64), dtype=np.float32)
        for i in range(16):
            for j in range(64):
                _D[i, j] = scale * np.float32(
                    np.cos((np.pi / 2.0 / 64.0) * (i + 1) * (2 * j + 1)))
    return _D


def _torben(m):
    flat = m.ravel()
    n = len(flat)
    lo, hi = np.float32(flat.min()), np.float32(flat.max())
    while True:
        guess = np.float32((lo + hi) / 2)
        less = int((flat < guess).sum())
        greater = int((flat > guess).sum())
        equal = n - less - greater
        below = flat[flat < guess]
        above = flat[flat > guess]
        maxlt = np.float32(below.max()) if len(below) else lo
        mingt = np.float32(above.min()) if len(above) else hi
        if less <= (n + 1) // 2 and greater <= (n + 1) // 2:
            break
        if less > greater:
            hi = maxlt
        else:
            lo = mingt
    if less >= (n + 1) // 2:
        return maxlt
    if less + equal >= (n + 1) // 2:
        return guess
    return mingt


def pdq_from_luma(luma):
    """luma: (rows, cols) float32 array, values 0..255.
    Returns (bits ndarray shape (256,), quality int) — bit k = 1 iff DCT
    coefficient (k//16, k%16) > median (same order as Hash256.setBit)."""
    rows, cols = luma.shape
    buf = luma.astype(np.float32).copy()
    if (rows, cols) != (64, 64):
        wrow = (cols + 127) // 128  # computeJaroszFilterWindowSize(cols, 64)
        wcol = (rows + 127) // 128
        buf = _jarosz(buf, rows, cols, wrow, wcol)
        b64 = _decimate(buf, rows, cols)
    else:
        b64 = buf

    # quality: quantized gradient count over the 64x64 downsample
    grad = 0
    d = ((b64[:-1, :] - b64[1:, :]) * 100 / 255).astype(np.int32)
    grad += int(np.abs(d).sum())
    d = ((b64[:, :-1] - b64[:, 1:]) * 100 / 255).astype(np.int32)
    grad += int(np.abs(d).sum())
    quality = min(grad // 90, 100)

    D = _dct_matrix()
    B = (D @ b64 @ D.T).astype(np.float32)
    median = _torben(B)
    bits = (B > median).astype(np.uint8).ravel()
    return bits, quality


def pdq_from_rgb(rgb):
    """rgb: (rows, cols, 3) uint8. Returns (bits, quality)."""
    luma = (REC601[0] * rgb[:, :, 0].astype(np.float32) +
            REC601[1] * rgb[:, :, 1].astype(np.float32) +
            REC601[2] * rgb[:, :, 2].astype(np.float32))
    return pdq_from_luma(luma)
