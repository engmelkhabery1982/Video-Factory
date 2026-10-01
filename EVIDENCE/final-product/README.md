# Final Product Acceptance — evidence

**API-level product E2E; UI rendered but not click-automated.**

This directory holds the LIGHTWEIGHT evidence produced by the Final Product
Acceptance workflow (`.github/workflows/final-product-acceptance.yml`).

Runtime artifacts — the rendered MP4s, the per-turn Kokoro WAVs and the
Kokoro model files — are **never** committed here. They are uploaded only as
GitHub Actions workflow artifacts.

## Baseline

| | |
|---|---|
| Acceptance branch | `arena/final-product-acceptance` |
| Created from | `65ffb06f4f48f01906b7d89e27674c24a199cdf0` |
| Source branch | `arena/final-product-integration` |

## Evidence files

| File | Produced by | Contents |
|---|---|---|
| `preflight-verification.json` | `preflight` job | Every preflight assertion, the generated Scenario/character/voiceSlot proof, the dialogue edit, the reopen/restart proof, the asset registration + binding + Phase 6A mediaMap proof |
| `short-smoke-media-verification.json` | `short-smoke` job | The native 1080×1920 Short: SHA256, size, duration, video/audio codec, geometry, audio-stream count |
| `long-media-verification.json` | `final-production` job | Same shape for the 1920×1080 Long |
| `short-media-verification.json` | `final-production` job | Same shape for the packaged 1080×1920 Short |
| `package-verification.json` | `final-production` job | Phase 6D package status, requested/packaged/failed targets, deliverable inventory, QC status, both media probes |
| `audio-verification.json` | `evidence` job | Real Kokoro audio: per-turn file count, distinct per-turn hashes, canonical 48 kHz mono PCM16, the configured voice slots |
| `asset-verification.json` | `evidence` job | The acceptance asset's provenance chain, its resolved mediaMap entry, the real `GET /media/asset/:id` proof and the data-root path resolution |
| `persistence-verification.json` | `evidence` job | What survived a fresh-process reopen: Scenarios, characters, voice slots, the dialogue edit, the asset binding, both fingerprints |
| `acceptance-summary.json` | `evidence` job | Roll-up of every stage |

A `*-FAILURE.json` file is written instead when a gate fails, and carries the
failing gate, the exact error and the relevant detail.

## What is proven

1. **Fresh, unseen content.** The acceptance project is authored for this run
   (`FinalAcceptance_RFI_Backlog`, a clearly fictional RFI-backlog training
   example). The canonical Phase 6E project, the schedule-risk fixture, the
   progress-meeting fixture, the shared test `dialogue.wav`,
   `tests/fixtures/render` and any previously rendered canonical Scenario are
   not used as the acceptance content.

   > Note on the two production-audio test suites the `preflight` job runs:
   > they are the product's own engine tests and internally reference the
   > product's own fixtures by design. They are run because the acceptance
   > requires the previously skipped `itProvisioned` real-audio gates to RUN
   > rather than skip. One of them (`gate 14`) is in fact the product's own
   > assertion that production proof never touches the shared
   > `tests/fixtures/render/dialogue.wav`.

2. **Real production audio.** Kokoro-82M (`onnx-community/Kokoro-82M-v1.0-ONNX`,
   q8) provisioned only via `npm run provision:tts`. No substitute TTS engine,
   no SAM fallback. Per-turn synthesis, canonical 48 kHz mono, and at least two
   distinct voice slots.

3. **Asset provenance chain.** The acceptance asset is generated locally by the
   acceptance script, registered through the real Asset Library HTTP route,
   bound through the normal production binding route, resolved by Phase 6A into
   the mediaMap, and used by Remotion. The mediaMap is never fabricated or
   injected through test-only internals.

   The product stores `Asset.path` **relative to the configured data root**
   (`DATA_DIR`, honouring `BUILDTRAKE_DATA`) — for example
   `assets/rfi-ageing-summary-xxxx.svg`. The acceptance driver resolves it the
   same way (`path.join(DATA_DIR, asset.path)`); it never assumes the repository
   root.

   The chain is closed with a real product media-serving proof: the running
   product server is asked for `GET /media/asset/:id` and the returned bytes are
   compared (SHA256) against both the real stored file and the asset the
   acceptance script originally generated. Nothing is bypassed.

4. **Persistence.** The project, both Scenarios, the characters and their voice
   slots, the accepted dialogue edit and the asset binding are all reloaded from
   disk by a freshly spawned process.

5. **Geometry authority.** Long is 1920×1080 and Short is 1080×1920, each built
   from its own independently generated Scenario. The Short is not a cropped
   Long layout.

6. **Phase 6D package.** The final export reaches a package whose manifest
   status is `ready` with `readyForProductionDelivery: true`, no failed targets
   and no error findings.

## What is NOT claimed

- No click-level browser automation was performed. The production HTTP routes
  the UI calls are exercised directly, and the real UI is built and served, but
  the browser is not driven through a click sequence. No browser-automation
  framework was added for acceptance.
