# Market Analysis

Research date: 2026-08-12.

## The gap

**No shipping mobile app combines hardware-signed video capture with a robust watermark soft binding + public recovery.** Closest players and why they don't cover it:

| Player | Video | Watermark | Gap |
|---|---|---|---|
| Truepic (Lens SDK + Vision) | Yes | Images only (Steg.AI partnership, AI-gen focus) | Enterprise-only, ~$1k/user/mo; no video watermark recovery |
| ProofMode (Guardian Project) | Yes | No | Grant-funded, no robust watermark |
| Sony Camera Verify | Yes | No (hard binding only) | $2,500+ camera bodies, newsroom-gated |
| Numbers Protocol / Click / ZCAM | Mixed | No | Crypto/token niche; ZCAM iPhone-only, just launched |
| Adobe TrustMark (C2PA soft binding ref.) | — | Image-only | No video variant shipped |
| Serelay | — | — | Dead (consumer-only model failed) |
| eyeWitness to Atrocities | Yes | No | Nonprofit, chain-of-custody instead of watermark; proves courts accept signed video (4 Ukrainian cases) |

Every public verifier fails exactly where users need it: nothing recovers provenance from a stripped/re-encoded social video. verify.contentauthenticity.org has no soft-binding recovery; Adobe's verifier app is image-only ("video coming soon" since Oct 2024).

## Who pays

- **Proven payer — insurance**: Truepic's market ($28–65/inspection). Don't fight there: they have 100+ enterprises and Microsoft/Adobe/Sony on the cap table.
- **Underserved prosumer verticals** (our target): legal evidence (process servers, landlords, family law — courts increasingly receptive, US FRE Rule 901(c) discussions), field/contractor documentation, creators chasing YouTube's "captured with a camera" label.
- **Dead end — pure consumer**: every consumer-only attempt is dead (Serelay), grant-funded (ProofMode, eyeWitness) or token-subsidized (Numbers, Nodle, ZCAM). Price self-serve $10–30/mo or per-capture, sell B2B2C.

## Distribution hook

**YouTube "Captured with a camera" label** (since Oct 2024): reads C2PA v2.1+ at upload, shows provenance label if the chain is intact. Almost no consumer tool can trigger it today — a signed-capture app gets visible platform validation for free. TikTok reads C2PA and re-attaches credentials on download; LinkedIn shows a "Cr" pin. Instagram/X: nothing (recovery service is the answer there).

## Timing

Tailwinds:
- **EU AI Act Art. 50** applies 2026-08-02: machine-readable marking mandatory for synthetic content → authenticity marking becomes the complement.
- **ISO 22144** (C2PA) at DIS stage; NSA/CISA recommend Content Credentials.
- **C2PA Conformance Program** open since mid-2025 — early Level 2 certification is credibility a small team can earn.

The clock:
- **California AB 853**: capture-device makers must embed provenance by default from **2028-01-01** → Apple/Google/Samsung will ship native C2PA capture. Window for a standalone capture app: **2–4 years**.
- Consequence: the durable asset is the **watermark recovery service + manifest registry + verification UX**, not the camera app. The app is the wedge.

## Verdict

Viable as a focused wedge: signed video + watermark recovery + best-in-class public verifier, sold to legal/field-documentation prosumers and creators. Not viable as a general consumer camera app or a Truepic insurance clone.
