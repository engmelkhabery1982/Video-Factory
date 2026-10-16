# Execution status / evidence ledger
Updated: 16 October 2026.
Last functionally reviewed integration: b557979eed42ff22e8bab3d7ed07bfb8640df945.
This documentation increment does not alter runtime code or mark additional capabilities accepted.
Current accepted remote release is the tip of review/owner-approved after owner synchronization, not necessarily the session branch. Read Git refs rather than guessing a future SHA.

| Order | State | Evidence / next gate |
|---|---|---|
| 01 local references | IMPLEMENTED, PENDING OWNER REVIEW (runtime BLOCKED) | Arena picture analysis, manual approval and reference conditioning are implemented with fixture/HTTP/DOM evidence. Vision and conditioning runtimes are not proven. See the 16 October Arena increment below |
| 02 inputs/planning | PARTIAL, remaining scope queued | Structural/silent owner fix and browser proof accepted; topic/audio/PDF/mixed end-to-end acceptance incomplete |
| 03 visual families | PARTIAL, engine decisions open | Procedural families have limited evidence; generated video/3D/talking-character runtime not accepted |
| 04 speech | PARTIAL | Optional Google workflow earlier reviewed in part; SAM HTTP succeeded for English; natural local Arabic not accepted |
| 05 sync/capture/recovery | PARTIAL | Preserve existing sync/undo/range/cache protections; missing cases need current evidence |
| 06 acceptance/release | NOT COMPLETE | Do not infer complete from previous fixtures or existing short renders |

## Latest actual owner review
See docs/execution/milestone-3/OWNER_STORYBOARD_CLOSEOUT_REVIEW_2026-10-16.md.
The silent-storyboard fix and local shotList test correction are already in the approved tree. Do not reimplement them.

## Known constraints / precise evidence limits
Approximately 16 GB RAM; AMD Radeon(TM) Graphics. WMI AdapterRAM is not proof of dedicated VRAM. CPU local-image runner and SD 1.5 base exist on owner F, not presumed on Arena.
Owner recording/transcription/approved timing evidence is private and not in Git. Fixture transcripts are not owner acceptance.
Owner review and session working trees may differ; inspect ancestry and integrate rather than resetting.
No provider call, model download or new dependency is authorized by this document.
Arena must append dated implementation/pending-review rows with exact evidence; only owner review records acceptance.

## Arena increment, 16 October 2026 (integration of session tip 262f364 with local commits)
Labels: IMPLEMENTED = code and tests present. PENDING OWNER REVIEW = not accepted by anyone. Arena does not mark any row owner-accepted.
Evidence labels: HTTP = app.inject through real routes. DOM = jsdom/happy-dom, not a browser. FIXTURE = fake runner or loopback vision stub. RUNTIME = real model or real runner (none in this sandbox).

| Item | Label | Evidence |
|---|---|---|
| Local picture analysis (llama-server, loopback only) with status, cancel, timeout, hash-keyed observations | IMPLEMENTED, PENDING OWNER REVIEW | tests/local-vision.test.ts; HTTP with loopback stub; DOM picture-analysis. Not a model-quality result |
| Manual approval of a reference picture: owner text, source and licence matched to the library, current-byte hash, explicit flags, no vision needed | IMPLEMENTED, PENDING OWNER REVIEW | tests/factory-manual-reference.test.ts 11/11 (HTTP, no vision server); tests/web/picture-analysis.test.tsx 18/18 (DOM) |
| Conditioning readiness independent of vision readiness | IMPLEMENTED, PENDING OWNER REVIEW | Same HTTP test: conditioning accepted with the vision URL on a closed port. Vision status is reported separately |
| Reference-conditioned stills: runner receives reference bytes, adapter, encoder and strength | IMPLEMENTED, PENDING OWNER REVIEW | HTTP argv evidence against tests/fixtures/fake-sd-cli.mjs only. NOT a stable-diffusion.cpp conditioned output |
| Candidates made under other strength, picture or review settings are refused on approve and bind | IMPLEMENTED, PENDING OWNER REVIEW | HTTP: approve returns 409 FACTORY_CANDIDATE_STALE after a strength change |
| Reference pictures are not automatic shot fallbacks | IMPLEMENTED, PENDING OWNER REVIEW. DELIBERATE OWNER-BEHAVIOUR CHANGE | packages/core draft-plan.ts; factory-binding tests |
| Owner sizing 640x384 and 384x640 with --vae-tiling and runtime flag validation | PRESERVED (owner-tested, merged) | tests/local-image.test.ts; the 640x360 mismatch is resolved to the owner values |
| Silent-storyboard fix (blank-panel duplicate, reorder, remove) reaches the applied editor visualClips.sourceAssetId | PRESERVED, HTTP | tests/factory-silent-storyboard-apply.test.ts |
| Gemini evidence binding includes the text model again | CHANGED BACK, PENDING OWNER REVIEW | gemini-service evidenceBinding; tests/gemini-transport-evidence.test.ts. Two owner fixtures now record the server default text model |

Verification run on the merged tree (exit codes as run):
- npm run build:core 0; npx tsc -p apps/api 0; npm run typecheck 0; npm run build:web 0.
- Vitest, 67 files (tests/web, factory, local, gemini, visual, owner-touched and new): 883 passed, 1 skipped, exit 0. The one skip is the BLOCKED zero-audio render row.
- node scripts/verify-local-visual.mjs --root /tmp/lv-test --fresh: exit 2 (BLOCKED, 0 pass, 0 fail, 10 blocked).

Blocked runtime gates (exact; none of these were run and none are passed):
- BLOCKED browser: no runnable Chromium or Playwright in this sandbox. Picture-analysis and manual-approval browser acceptance not run. tests/external-audio-seek-browser.test.ts remains blocked.
- BLOCKED vision runtime: llama-server b11429 and the Qwen2-VL GGUF are not provisioned. Owner command: node scripts/verify-local-visual.mjs --root data/local-visual-verify (exit 2 here).
- BLOCKED conditioning runtime: SD base, IP-Adapter and CLIP Vision are not provisioned. No real conditioned generation has run.
- BLOCKED owner runtime: Pair A (religious still life) and Pair B (educational truck) are UNPROVEN.
- BLOCKED engine: zero-audio export render (tests/factory-input-matrix-integrated.test.ts, it.skip). Needs the Remotion render engine and a browser.

Owner decisions needed:
1. Confirm the reference fallback exclusion (style and character pictures are never automatic shot fallbacks).
2. Confirm the restored Gemini text-model evidence binding.
3. Review licences: stable-diffusion base (CreativeML Open RAIL-M), Qwen2-VL-2B (apache-2.0; base not separately read), IP-Adapter (apache-2.0).
