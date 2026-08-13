# Research Findings

Summary of the research phase (2026-08-12): state of the art, algorithms, key papers, attacks. Sources linked inline.

## Problem

AI generation makes photo/video authenticity unverifiable by inspection. Goal: prove at verification time that a video was (a) captured by a specific physical device, (b) captured in real time, (c) not modified afterwards.

## State of the art

### The standard: C2PA / Content Credentials

[C2PA](https://spec.c2pa.org/specifications/specifications/2.4/specs/C2PA_Specification.html) (Adobe, Google, Sony, Microsoft; 6,000+ orgs) already defines exactly this: a signed manifest (COSE/X.509) embedded in the asset, containing content hashes ("hard bindings"), capture metadata assertions, and an attestation chain. Key facts:

- **Video support**: BMFF hash with per-fragment Merkle trees for fragmented MP4; live-streaming manifests added in v2.4 (April 2026, §19).
- **Trust model**: curated CA trust list + [Conformance Program](https://c2pa.org/conformance/) (Level 1 self-asserted / Level 2 hardware-backed keys) since mid-2025.
- **Regulatory backing**: EU AI Act Art. 50 (applies 2026-08-02) points to C2PA; ISO 22144 near-final (DIS); NSA/CISA [recommend Content Credentials](https://media.defense.gov/2025/Jan/29/2003634788/-1/-1/0/CSI-CONTENT-CREDENTIALS.PDF).

Verdict: build C2PA-conformant, don't invent a format.

### Shipping hardware

| Device | What it does | Notes |
|---|---|---|
| Google Pixel 10 (2025) | Photo C2PA by default. Keys in StrongBox (Titan M2), per-image anonymous certs, on-device RFC 3161 TSA | Reference architecture, fully [documented](https://blog.google/security/pixel-android-trusted-images-c2pa-content-credentials/). No video |
| Sony A1/FX3/PXW-Z300 (2024-25) | First **video** C2PA + 3D depth check against screen-replay | Newsroom-gated, $2,500+ bodies |
| Leica M11-P (2023) | First C2PA camera ever | Photo only |
| Nikon Z6III | C2PA — **broken 2025**: researcher got the camera to sign an AI image (multiple-exposure + grafted NEF); all certs revoked | Lesson: the weak point is *what* you sign, not the crypto |
| Qualcomm Snapdragon 8 Elite Gen 5 | Truepic C2PA library embedded in TEE, photo+video | OEM opt-in capability |

## Algorithm layer

### Why two layers are needed

- **Signature alone**: social platforms strip C2PA metadata on upload (~100% as of 2026). A stripped file isn't "tampered", just unsigned — signatures prove integrity, not presence.
- **Watermark alone**: statistical, hence removable ([UnMarker: 79% vs SynthID](https://arxiv.org/pdf/2310.07726)) and forgeable. Not a trust anchor.
- **Together**: exact per-GOP signature for full-integrity verification of intact files + robust watermark as C2PA "soft binding" carrying an ID to recover the manifest from a registry after transcode.

### Chosen algorithms

- **Per-GOP rolling signatures in SEI NAL units** — the [Axis Signed Video](https://developer.axis.com/video-streaming-and-recording/signed-video/) model, standardized as [ONVIF Media Signing](https://www.onvif.org/specs/2412/ONVIF-MediaSigning-Spec-v2412.pdf) (open source, MIT, C). Each GOP hash chains the previous one → proves continuous ordered capture. Dies on transcode (by design).
- **[VideoSeal](https://github.com/facebookresearch/videoseal)** (Meta, MIT) for the robust watermark — 256-bit payload, temporal propagation (embeds on frame subset), trained against H.264 proxies. Validated in our spikes (see doc 04).
- **ES256 (ECDSA P-256)** signing keys — the only curve available in Android StrongBox and Apple Secure Enclave. Attestation chain: device key → Google/Apple root, verified server-side.
- **RFC 3161 timestamping** of the rolling hash within seconds of capture → bounds capture time ("existed before T"); attestation challenge nonce bounds it from below.

## Key papers

| Paper | Year | Relevance |
|---|---|---|
| [VideoSeal](https://arxiv.org/abs/2412.09492) | 2024 | SOTA open-source video watermarking (our choice) |
| [DeepSignature](https://arxiv.org/html/2604.23016) | 2026 | Closest to full vision: Ed25519 signature of VQ-VAE latent embedded as neural watermark |
| [Signing Right Away](https://arxiv.org/pdf/2510.09656) | 2025 | Signing raw sensor data before the ISP (anti-injection), MIPI CSF |
| ETH Zurich sensor chip ([Nature Electronics](https://techxplore.com/news/2026-03-sensor-chips-deepfakes-adding-cryptographic.html)) | 2026 | Signature inside the sensor die — tampering requires physical chip attack |
| [VerITAS](https://eprint.iacr.org/2024/1066) | 2024 | zk-SNARK proof that an edited photo derives from a signed original via permitted edits only |
| [zk-Cinema](https://eprint.iacr.org/2026/1598) | 2026 | First ZK provenance for video (bleeding edge, prover-heavy) |
| [ChunkySeal](https://arxiv.org/abs/2510.12812) | 2025 | 1024-bit watermark capacity — enough for a full signature in-band |

## Fundamental limits (not solvable with more crypto)

1. **Analog hole**: a trusted camera filming a 4K OLED screen produces a *validly signed* capture of fake content. Mitigations (depth sensing, moiré detection, light-field) are signals, not guarantees; moiré detection is degrading as displays improve.
2. **Injection before signing**: HDMI-to-CSI, virtual camera drivers, Frida hooks — exploited at scale against KYC (8,065 attempts vs one bank, Jan–Aug 2025, Group-IB). Sensor-level signing moves the attack point but doesn't eliminate it.
3. **Key compromise**: one leaked vendor/device key = mass forgery of "authentic" media. TEEs don't resist sophisticated physical attackers. Key management is the systemic single point of failure.

**Honest claim** the system can make: "recorded by this device, in this time window, unmodified since capture" — never "this video is true". Overclaiming killed credibility for others (Nikon case).
