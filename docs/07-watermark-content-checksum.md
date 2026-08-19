# 07 — Content checksum inside the watermark (exploration)

Date: 2026-08-17. Status: **superseded** (2026-08-19). Shipped for photos in app
1.1.x, then rolled back: verdicts from an in-band perceptual hash proved harder to
sell than simply showing the copy next to the verified original, and the freed
payload now carries a 128-bit random capture id (payload v3, app 1.2.0) that keys
the original lookup (`web/samples.json` today, cloud registry in the full design).
The BCH layer validated here survived into v3; the PDQ ports remain in `spikes/`
and this doc stands as the research record. See also
`spikes/spike_strength_sweep.py` (photo embed strength ×1.5 → ×1.2).

Goal: put a checksum of the captured pixels *inside* the VideoSeal payload so that a
re-encoded copy (trailer stripped, C2PA-style metadata gone) can still be checked for
AI/semantic edits. Today the payload only carries a pointer (`deviceId<<14 | counter`);
[02-architecture.md](02-architecture.md) already planned a "truncated chain hash" slot —
this doc works out what kind of hash can actually live there and what it proves.

## The core tension

| Hash type | Survives WhatsApp re-encode | Flags AI edit | Security |
|---|---|---|---|
| Cryptographic (SHA-256, current trailer) | no — breaks on any transcode | yes (breaks on everything) | strong, signed |
| Perceptual (pHash/PDQ) | yes | yes, if edit is semantic and above threshold | weak alone — thresholded, adversarially forgeable |

Crypto hash already exists in the proof trailer and covers the intact-file tier.
The watermark slot must therefore carry a **perceptual** hash: it is the only thing that
survives the pipelines the watermark itself was chosen to survive. Consensus
architecture (C2PA "Durable Content Credentials", three pillars): signed metadata +
invisible watermark + perceptual fingerprint, each covering the others' weaknesses.
Ref: https://contentauthenticity.org/blog/durable-content-credentials

## Research findings (condensed)

### Perceptual hashes — candidates for the "checksum"

- **PDQ** (Meta, 2019, open source, C++ in ThreatExchange): 256-bit DCT-based image
  hash, production-tested at scale, robust to resize/recompression. Best open candidate.
  https://arxiv.org/abs/1912.07745
- **TMK+PDQF** (Meta): whole-video matching, but vectors ~256KB — unusable in-band.
  For video the practical pattern is per-sampled-frame PDQ + order-sensitive chain digest
  (catches cuts/reordering — the attack class pixel hashes miss, arXiv 2208.05198).
- pHash/aHash/dHash (64 bit): cheaper but too coarse — small local edits (face swap in a
  small region) can stay under the global threshold. Grid/block-wise variants localize.
- **Attacks**: any public perceptual hash is adversarially forgeable (collision) and
  evadable — NeuralHash break (Struppek, FAccT 2022, arXiv 2111.06628), collisions on
  classical hashes too (Dolhansky 2020, arXiv 2011.09473), black-box collisions on
  PhotoDNA/NeuralHash (ePrint 2024/1869). PDQ compared favorably on benign robustness
  (arXiv 2406.00918). Conclusion: a pHash is a *tamper indicator*, never *proof*.

### Semi-fragile watermarking — the alternative framing

- Classic semi-fragile schemes (SARI, Lin & Chang 2001; DCT/IWT descendants) tolerate
  one known-quality JPEG pass; social pipelines destroy them. Dead end for us.
- **FaceSigns** (UCSD, arXiv 2204.01960, ACM TOMM 2024): neural semi-fragile watermark,
  128-bit payload, trained to survive benign ops and *die* on face swap/reenactment,
  AUC 0.996 on unseen deepfake methods. Closest paper to this feature. Face-centric
  training; would need retraining for general scenes. Competes with — rather than
  composes with — our VideoSeal investment.
- Surveys: ACM CSUR 2025 proactive deepfake defense (10.1145/3771296),
  arXiv 2407.10575. VideoSeal is a *robust* mark: by design it survives edits, so
  tamper evidence must come from payload mismatch, not mark destruction.

### Ecosystem

- C2PA Soft Binding API standardizes exactly this pattern (watermark/fingerprint →
  manifest recovery): https://spec.c2pa.org/specifications/specifications/2.2/softbinding/Decoupled.html
- Adobe TrustMark (MIT): ~100-bit BCH-coded payload, official CAI soft-binding carrier —
  validates our payload-size ballpark, image-only, we keep VideoSeal.
- SynthID solves the inverse problem (mark AI output at generation); context only.

## What fits in 256 bits

Budget: VideoSeal 256-bit message. Measured worst case 13/256 wrong bits across the
phase-0 transcode ladder ([04-phase0-spikes.md](04-phase0-spikes.md)), which already
noted BCH(255,131) corrects 18.

Proposed layout (replaces the 32×8 repetition codec — **payload v2, must be versioned**):

```
BCH(255,131, t=18) over:
  proofId   24 bit   (deviceId 10 | counter 14, unchanged)
  pHash    107 bit   photo: PDQ truncated 256→107
                     video: PDQ of sampled keyframes folded/truncated + chain digest (TBD)
  1 spare bit pads to 256
```

- t=18 vs worst measured 13 → thinner margin than today's 8× repetition (which survived
  everything). Must re-measure decode failure rate with BCH on the phase-0 ladder.
- PDQ truncation 256→107: Hamming threshold scales roughly linearly (PDQ quality metric
  is distance/256 ≤ 31 typical → ~13/107); discriminative power to be measured (spike).
- Video: per-segment payloads (one per 16-frame embed chunk) measured in spike C
  below — viable, with a recovery-rate trade-off after harsh transcodes.

## What it proves — threat analysis

Verification flow on a transcoded file: decode payload → recompute PDQ on received
pixels → Hamming distance vs embedded claim.

- **Benign re-share** (WhatsApp, YouTube): payload decodes, pHash within threshold →
  "consistent with capture, recompressed". This is the new capability — today a
  transcoded file yields only "some registered device, some counter".
- **AI edit on our capture** (inpainting, face swap, background replace): VideoSeal is
  robust, payload likely survives → embedded pHash no longer matches pixels → **flagged**.
  If the edit is heavy enough to kill the watermark → "no provenance", also a signal.
- **Forgery**: attacker generates fake image, computes its PDQ, embeds a valid-looking
  payload with open VideoSeal. In-band bits are *not signed* — 256 bits cannot hold an
  ECDSA signature (512+ bit), truncated signatures are unverifiable, HMAC needs a secret
  the verifier can't have. So in-band pHash gives **tamper evidence, not authenticity**.
  Authenticity still requires the out-of-band tier: proofId → signed record lookup
  (per-capture registry = infrastructure, conflicts with the zero-infra constraint;
  or the existing trailer when the file is intact). This limit must be explicit in
  verifier UX: "unmodified since watermarking" ≠ "authentic TrustCam capture".
- **Adversarial pHash games**: collision/evasion attacks apply (see above). Acceptable
  for an indicator tier; the signed tiers are the security anchor.

## Verifier UX tiers (proposed)

1. Trailer intact + sig valid → "bit-exact original" (today, unchanged).
2. Trailer gone, payload decodes, pHash matches → "content consistent with capture,
   recompressed" (new).
3. Payload decodes, pHash mismatch → "modified after capture" (new, the AI-edit flag).
4. No payload → "no provenance".

## Spike results (2026-08-17)

Payload correction vs plan: bchlib byte-aligns data at 16 bytes → **104 pHash bits**,
not 107. Layout: proofId 24 | pHash 104 | BCH parity 124 | pad 4 = 256.

### Spike A — PDQ separation at 104 bits: PASS

[spike_pdq_separation.py](../spikes/spike_pdq_separation.py) /
[results/pdq_separation.json](../spikes/results/pdq_separation.json).
8 frames from the phase-0 test clip; benign = JPEG q85/70/50, resize 0.75/0.5/1280w
+ recompress; edits = donor-patch paste 10/20/30% (inpaint stand-in), cv2 inpaint 15%,
crop 10/20%.

| Class | Hamming @104 bit |
|---|---|
| Benign (all ops, all frames) | **0–3** |
| Edits (all ops, all frames) | **8–60** (patch10 min 8, crop20 max 60) |

Full separation, no overlap. Scaled PDQ threshold (31/256 → ~12.6/104) sits inside the
gap; a conservative accept threshold of ~5–6/104 splits cleanly. Caveats: small sample
(8 images, one scene family), synthetic edits — a real-model inpainting pass and photos
from actual phone cameras are the obvious follow-up.

### Spike B — BCH(255,131) codec: PASS (synthetic), ladder pending

[codec_v2.py](../spikes/codec_v2.py) + [spike_bch_codec.py](../spikes/spike_bch_codec.py) /
[results/bch_codec.json](../spikes/results/bch_codec.json). 500 trials per flip count,
random and burst patterns:

- 100% exact recovery up to **18 flips** (t=18 as designed); phase-0 worst channel = 13.
- Beyond 18: fails **clean** (decode error), **0 miscorrections** in the whole sweep —
  no silent wrong-payload risk.
End-to-end on the real channel ([spike_bch_robustness.py](../spikes/spike_bch_robustness.py) /
[results/bch_robustness.json](../spikes/results/bch_robustness.json)): codec_v2 payload
embedded in the phase-0 clip, full transcode ladder, **exact payload recovery in all 8
conditions**. WhatsApp 480p: 3 flips corrected; worst (stress 360p/500k): 15 corrected
of t=18 — margin 3, thinner than this run suggests alone (phase 0 measured 13 on the
same condition; run-to-run variance exists). Everything at or above WhatsApp quality
sits at 0–3 flips, nowhere near the limit.

### Spike C — per-segment video payloads + segment length sweep: PASS, 32 frames

[spike_video_segments.py](../spikes/spike_video_segments.py) /
[results/video_segments.json](../spikes/results/video_segments.json).
Each segment of N frames carries its own codec_v2 payload (same proofId, distinct
pHash), embedded via the same chunked pipeline the app uses. Sweep N ∈ {16, 32, 48}
on the phase-0 clip (256 frames, 24fps).

Segments recovered (blind sliding window, stride 1, no boundary info):

| Segment length | Baseline | WhatsApp 480p/1M | Trim @ frame 70 (misaligned) |
|---|---|---|---|
| 16f (0.7s) | 16/16 | 10/16 | 7/6* |
| **32f (1.3s)** | **8/8** | **8/8** | **4/2*** |
| 48f (2.0s) | 5/5 | 4/5 | 2/1* |

*more found than fully-contained: partially-contained segments also decoded.

Findings:
- **32 frames is the operating point**: full recovery in every condition, including
  the misaligned trim (6-frame offset = 19% window contamination, still decodes).
  16f loses 6/16 segments at WhatsApp quality; 48f loses one segment there too —
  likely content-dependent (single clip, small n), not worth the coarser granularity.
- Mixed-message averaging fails **clean** (BCH) and 0 wrong payloads across all
  blind windows in the whole sweep — the verifier can slide stride-1 with no
  false-positive risk.
- Blind recovery on trimmed clips works with no boundary info — clip-resistance holds.

## Implementation (photos, app 1.1.0)

- Capture: `PhotoWatermarker` computes PDQ-104 on the pre-embed luma, embeds a
  v2 payload (`PayloadCodecV2.kt` — BCH encode via a 128×124 basis matrix, XOR of
  rows, bit-parity with bchlib guaranteed by construction). Proof trailer gains
  additive fields `pv: 2` + `phash`.
- Verify: `web/js/codec_v2.js` (full BCH decode: syndromes, Berlekamp-Massey,
  Chien) + `web/js/pdq.js`; verifier tries v2 first (false-accept ~2^-124),
  falls back to v1. Verdict tiers on Hamming @104: ≤6 content intact, 7–11
  inconclusive, ≥12 modified.
- Parity: all ports tested against `spikes/results/checksum_vectors.json`
  (`spikes/export_checksum_vectors.py`). Note: the `pdqhash` python binding
  returns bits in reverse order vs the C++ `setBit` convention — canonical
  order (and the embedded 104 bits = lowest DCT frequencies) is
  `spikes/pdq_ref.py`.

### Remaining work

4. Validate PDQ separation on real phone photos + real-model inpainting (spike A
   caveat); re-run sweep on more clips before freezing the video contract.
5. Video v2: per-segment payloads (32-frame contract, spike C). The verifier is
   now single-source (`web/js/verifycore.js` shared by `verify.html` and the
   node CLI `web/verify.mjs`, which downloads the site's own modules + wasm),
   so v2 video lands in one place.

## Sources

- PDQ / TMK+PDQF: https://about.fb.com/news/2019/08/open-source-photo-video-matching/ ·
  https://raw.githubusercontent.com/facebook/ThreatExchange/main/hashing/hashing.pdf
- PDQ evaluation: https://arxiv.org/abs/1912.07745 · adversarial: https://arxiv.org/html/2406.00918v1
- NeuralHash break: https://arxiv.org/abs/2111.06628 · https://arxiv.org/pdf/2011.09473 ·
  https://eprint.iacr.org/2024/1869.pdf
- FaceSigns: https://arxiv.org/abs/2204.01960 · https://dl.acm.org/doi/10.1145/3640466
- Proactive defense surveys: https://dl.acm.org/doi/10.1145/3771296 · https://arxiv.org/html/2407.10575v3
- C2PA soft bindings: https://spec.c2pa.org/specifications/specifications/2.2/softbinding/Decoupled.html
- Durable Content Credentials: https://contentauthenticity.org/blog/durable-content-credentials
- TrustMark: https://arxiv.org/pdf/2311.18297 · https://github.com/adobe/trustmark
- Temporal tampering via robust hashing: https://arxiv.org/pdf/2208.05198
- SARI (semi-fragile foundation): Lin & Chang 2001 — https://www.semanticscholar.org/paper/d1c0369f18d5f6e3afec62a86e090f1a090edf8b
- SynthID: https://deepmind.google/models/synthid/
- NSA/CISA Content Credentials CSI: https://media.defense.gov/2025/Jan/29/2003634788/-1/-1/0/CSI-CONTENT-CREDENTIALS.PDF
