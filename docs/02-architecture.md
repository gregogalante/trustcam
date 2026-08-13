# Architecture

Target: Android-first mobile capture app + server-side verification/recovery service. C2PA-conformant.

## Design principle

Two complementary integrity layers, because each fails where the other holds:

| Layer | Proves | Survives transcode? |
|---|---|---|
| Per-GOP rolling signature (SEI NAL) | Exact bitstream integrity, continuous ordered capture, device identity | No (pixel-exact by design) |
| Robust invisible watermark (VideoSeal) | Pointer to full manifest in registry (device ID + segment index + truncated hash) | Yes (validated ≥94.9% worst case) |

An intact file verifies fully offline via layer 1. A social-laundered copy recovers its provenance via layer 2 + registry lookup.

## On-device capture pipeline (Android)

```
CameraX ──► MediaCodec (async, H.264/H.265)
                 │  onOutputBufferAvailable: encoded access units
                 │  (KEY_FRAME flag = GOP boundary)
                 ▼
   [1] Rolling hash per GOP  ── hash(GOP_n ‖ hash_{n-1}) — chained
   [2] Sign hash with StrongBox key (ES256)  ── fallback TEE, level recorded in manifest
   [3] Build SEI NAL (type 5, user-data-unregistered, ONVIF Media Signing format)
       and prepend to the access unit
   [4] VideoSeal embedder on NPU (I-frames + temporal propagation)
       payload: device ID + segment index + truncated chain hash (256 bit, BCH-coded)
                 ▼
       MediaMuxer (or minimal fMP4 muxer if SEI passthrough breaks on some OEMs)
                 ▼
   [5] C2PA manifest (c2pa-android): BMFF Merkle hard binding,
       attestation assertion, RFC 3161 timestamp
                 ▼
   [6] Upload manifest + attestation chain to manifest registry
```

Notes:
- MediaCodec cannot emit custom SEI — the app constructs the NAL and prepends it to the buffer before `writeSampleData`. Known-working app-level pattern; OEM quirks are a phase-0 open item.
- Watermark embedding happens on **decoded/preview frames before encoding** (embedder input is Y channel only — fits YUV pipelines without RGB conversion).
- VideoSeal embedder processes at 256×256, watermark residual upscaled to full res.

## Key management

- Per-device (later: per-recording) P-256 key generated in StrongBox; `FEATURE_STRONGBOX_KEYSTORE` absent on many mid-range devices → TEE fallback, security level always recorded as a manifest assertion.
- Android Key Attestation chain (device key → Google Hardware Attestation Root) verified server-side; challenge nonce binds session start time. Heads-up: new RKP root mandatory since 2026-04-10.
- C2PA signing cert: start with SSL.com free tier (1× Level 1 cert + 10k timestamps/yr), target Conformance Level 2 (hardware-backed) once shipping.

## Server side

- **Attestation verifier**: validates Keystore/App Attest chains, issues/registers per-device signing certs.
- **Manifest registry**: manifests + attestation chains indexed by watermark payload ID. This DB is the durable asset.
- **Public verifier** (the product): upload a file or paste a social link →
  1. try C2PA manifest validation (intact file: full offline-style verification);
  2. else run VideoSeal extractor (24M params, server-side) → BCH-decode payload → registry lookup → show provenance + what can/can't be claimed.

## iOS (phase 2)

Same shape: `AVCaptureVideoDataOutput` → `VTCompressionSession` (compressed sample buffers) → rebuild `CMBlockBuffer` with SEI appended → `AVAssetWriter` passthrough. Secure Enclave P-256 + App Attest. Caveat: VideoToolbox injects its own SEI — parsers must tolerate it.

## Component stack (all verified available)

| Component | Choice | License | Status |
|---|---|---|---|
| C2PA manifests | [c2pa-rs](https://github.com/contentauth/c2pa-rs) + [c2pa-android](https://github.com/contentauth/c2pa-android) | MIT/Apache-2 | Ready; fMP4 Merkle supported; video path needs FFI-level work |
| Per-GOP SEI signing | [ONVIF media-signing-framework](https://github.com/onvif/media-signing-framework) (C) | MIT | Ready; cross-compile with NDK; no mobile port exists yet (first-mover) |
| Watermark | [VideoSeal](https://github.com/facebookresearch/videoseal) v1.0 256-bit | MIT | Validated in spikes; mobile export is our work |
| Server verification | c2pa-node-v2 + VideoSeal extractor (PyTorch) | MIT | Ready |
| Trust list cert | SSL.com (free L1) → Conformance L2 | — | Open to indie; paperwork-heavy |

## Honest claims (product copy constraint)

Claim: **"recorded by this device, in this time window, unmodified since capture."**
Never claim: "this video is real/true." Analog hole (filming a screen) and pre-signature injection remain open; depth/IMU coherence signals go in the manifest as *signals*, not guarantees.
