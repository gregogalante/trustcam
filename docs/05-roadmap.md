# Roadmap

## Phase 0 — De-risking spikes ✅ (2026-08-12)

- [x] Watermark robustness vs simulated social transcodes → PASS (see doc 04)
- [x] Embedder exportability + latency proxy → PASS (see doc 04)
- [x] Real platform round-trip, YouTube: **99.61% bit accuracy** (1/256 wrong) after real upload/re-encode
- [x] Real platform round-trip, WhatsApp: **100%** (light HD re-encode, 1080p kept)
- [~] Real platform round-trip: TikTok (skipped for now)
- [x] On-phone benchmark (Moto G75, SM6475): fp32 ~1045ms/inference — **needs int8+QNN for mid-range real-time**; see doc 04
- [x] MediaMuxer SEI passthrough, Motorola/Qualcomm: **60/60 SEI preserved** (hardware encoder c2.qti.avc.encoder)
- [ ] SEI passthrough on more OEMs (Samsung/Xiaomi)
- [ ] int8 quantization + QNN EP benchmark (carry-over to phase 1)

## Phase 1 — Android MVP (~2–3 months)

Capture app: CameraX → MediaCodec per-GOP rolling hash → StrongBox ES256 signature → SEI injection (ONVIF Media Signing format) → C2PA manifest (c2pa-android, BMFF Merkle) → RFC 3161 timestamp. SSL.com Level 1 cert. Web verifier validating intact files.

Milestone: a clip that triggers YouTube's "Captured with a camera" label.

## Phase 2 — Recovery service

- VideoSeal embedder in the capture pipeline (NPU)
- Manifest registry indexed by watermark payload
- Public verifier: upload a re-encoded copy / paste a social link → extract watermark → BCH decode → registry lookup → full provenance display
- The demo that sells: record → post to TikTok → verify the TikTok copy.

## Phase 3 — Monetization + iOS

- B2B2C: legal evidence prosumers, field documentation, creators. $10–30/mo self-serve or per-capture. Avoid head-to-head with Truepic on insurance.
- iOS port (VTCompressionSession + Secure Enclave + App Attest).
- C2PA Conformance Level 2 certification.
- SDK offering.

## Later / research options

- Depth/IMU coherence signals in manifest (analog-hole mitigation as signals, not guarantees)
- ChunkySeal (1024-bit) → full signature in-band, registry-free verification
- ZK edit provenance (VerITAS/zk-Cinema) when video proving costs become practical
