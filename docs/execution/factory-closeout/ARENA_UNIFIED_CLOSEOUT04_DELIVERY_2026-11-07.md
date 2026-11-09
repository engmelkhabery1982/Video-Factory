# VF-20261107-UNIFIED-CLOSEOUT04 — consolidated Arena delivery

## Status

**ALL PERMITTED INDEPENDENT IMPLEMENTATION COMPLETED — OWNER-HOST REVIEW PENDING**

This describes the bounded code/recovery/documentation scope only. It is NOT full factory closure, operational-release approval, real inpainting, real browser capture, rendered-output evidence, listening approval or owner acceptance. Host checks may still find defects; those must be repaired before release.

## Git identity and preservation

- Fixed execution branch: `arena/dc133a86-video-factory`.
- Provisioned base: `b235b002df4cab2237ef0a8093b1aeef225f6903`.
- Pre-edit independently reviewed source: `41b28c06f499bb97786f7d4646c4eb8062d7ef0e`.
- Accepted authority retained, not advanced: `daae482aac9de85e993599a6d010e29908ac567a`.
- Required ancestors verified earlier: `c02bd2482b8b372324c9156982e03e120fc6b54f`, `b6637edc07617ab80776860258083ed15b40c0c2`, and `e593883d4f82bee98b4d99b896644811c2704008`.
- The shallow clean checkout was fast-forwarded from the provisioned ancestor to the reviewed source. The reviewed `c02bd24..41b28c0` delta was exactly 13 paths, +1845/-235; it was not broad tree replacement.
- No reset, clean, forced checkout, force push, unknown-file deletion, main merge, deployment or publish occurred. No owner branch was advanced.
- The delivery commit/full remote equality is resolved with `git rev-parse HEAD` and `git ls-remote --heads origin arena/dc133a86-video-factory` after the normal session-branch push; the final Arena handoff reports those full values.

## Implemented package

### G7 — masked/regional still correction

- Strict canonical pixel-mask v1: bounded base64/JSON, exact fields, integer regions, nonempty/bounded regions, original-dimension matching, canonical encoding and recursive fingerprints.
- Real bound-original verification: selected unlocked scene, active/eligible library record, source/licence, regular non-symlink library file, measured PNG/JPEG type and dimensions, index hash and supplied original hash.
- Durable versioned jobs under `DATA_DIR/factory/masked-corrections/jobs`, atomic writes, bounded job bytes/total/per-draft retention/attempts and one active runner. Readiness is explicit when no runner is registered.
- Cancellation, timeout, late-result invalidation, retry budgets, idempotency keys, terminal cleanup, startup interruption recovery and stale-result/target handling.
- Results must be distinct canonical images with matching declared/index/actual hashes and dimensions, `factory` + `masked-correction-result` tags, and exact job/run/runner/original/mask source provenance. Verification occurs before review and again at Apply/recovery.
- Frozen input/target/result/review fingerprints. Target fingerprints omit global revision but include the actual target scene/treatment/profile/format/audio/original; unrelated-scene edits can rebase, while target/source/review changes cannot be bypassed by sending the newest revision.
- Canonical same-lock Apply and atomic draft marker preserve newer bindings and locks. Post-bind/job-save faults remain `applying` and reconcile only the exact marker without a second bind.
- Existing ContentPlan/local-still workflow now has typed client methods plus bound-scene selection, pixel rectangle/instruction editing, local validation, runner readiness, persisted-job reopen/refresh, original/result comparison, provenance/errors, review/reject/retry/cancel/cleanup, explicit Apply and explicit interrupted-Apply reconciliation.
- No production runner is registered. `createMockRunner` is labelled fixture-only and refused in production; no fixture result is actual inpainting.

### G10 — consented capture

- Record is a direct action only in `idle`/`error`. Nonempty `processing`, `uploading`, `upload_failed` and `uploaded` work cannot open another stream or clear chunks; Upload/Discard/Capture-another is explicit.
- The canonical phase decision occurs synchronously before every media API/chunk/recorder mutation. Repeated Stop is guarded by synchronous state.
- StrictMode/start/upload locks, late permission invalidation, late-stream release, listener/timer/track cleanup, upload-failure retry/discard, operator confirmation and API-plus-MediaRecorder readiness are retained.
- Both owner-identified harness defects are repaired: discard absence uses direct `querySelector`, and repeated Stop retains/clicks the same element in one batch. Old capture-during-processing/upload expectations were replaced with preservation/explicit-Discard assertions.

### G11/G12 — independent recovery and release package

- Added dependency-free offline `scripts/factory-data-recovery.mjs`: SHA-256 manifest, sorted portable relative paths, regular-file/symlink checks, source/copy hash comparison, duplicate/traversal/extra/missing/tamper refusal, explicit restore confirmation and absent/empty-only non-merging destination.
- Release guide now separates implemented paths from release approval, documents masked jobs and exact offline backup/verify/restore commands, and retains all runtime/quality gates.
- Matrix, engine decision sheet and rollback manifest reconcile the complete scope. Rollback is revert-based and never instructs destructive replacement of unknown work or live owner data.

## Executed evidence (installed Node only)

Combined command:

```bash
node --experimental-transform-types --test \
  tests/capture-state-machine.test.mjs \
  tests/factory-masked-correction-pure.test.mjs \
  tests/masked-correction-ui-pure.test.mjs \
  tests/factory-data-recovery.test.mjs
```

Result: **72 tests, 72 passed, 0 failed, 0 skipped**, exit 0.

| Evidence label | Suite | Result | What it proves / does not prove |
|---|---|---:|---|
| PURE | `tests/capture-state-machine.test.mjs` | 31/31 | Canonical capture transitions and retained-capture guards; not DOM/browser capture |
| PURE | `tests/factory-masked-correction-pure.test.mjs` | 27/27 | Strict masks, fingerprints and finite limits; not HTTP/durable-store execution |
| PURE | `tests/masked-correction-ui-pure.test.mjs` | 6/6 | Browser mask assembly is accepted by the canonical parser and rejects bad geometry; not a component/browser |
| PURE + REAL TEMP FILES + CLI | `tests/factory-data-recovery.test.mjs` | 8/8 | Disposable synthetic backup/verify/restore, tamper/path/symlink/nonempty refusal and actual CLI round trip; not owner-data/live recovery |

Additional executed checks:

- `node --experimental-transform-types --check` passed, syntax only, for `apps/api/src/routes/factory.ts`, `apps/api/src/server.ts`, `apps/api/src/services/factory-service.ts`, `apps/api/src/services/masked-correction.ts`, `apps/api/src/services/masked-correction-contract.ts`, `apps/web/src/lib/capture.ts`, `apps/web/src/lib/factory-api.ts`, `apps/web/src/lib/masked-correction.ts`, `packages/core/src/factory/contract.ts`, and `tests/factory-masked-correction.test.ts`.
- `node --check scripts/factory-data-recovery.mjs` passed.
- `git diff --check` passed after removing four trailing-space warnings; an explicit changed-file scan also covered untracked files and passed.
- Node was `v22.22.3`; npm `10.9.8`. No project TypeScript/Vitest/Fastify/Vite/happy-dom modules are installed in this sandbox.

**Syntax-only parsing is not TypeScript typechecking, TSX compilation, a production build or owner acceptance.**

## Written but NOT RUN here

| Suite | Cases | Exact blocker |
|---|---:|---|
| `tests/factory-masked-correction.test.ts` | 22 | Vitest/Fastify and project dependencies absent. Real routes/store with owned in-memory PNG fixtures and labelled mock runner; not real inpainting |
| `tests/web/capture-panel.test.tsx` | 29 | Vitest/happy-dom/TSX toolchain absent. Browser-API doubles, not a browser |
| `tests/web/masked-correction-panel.test.tsx` | 9 | Vitest/happy-dom/TSX toolchain absent. Labelled client double, not engine/browser evidence |
| Core rebuild + API typecheck + root/web typechecks + production web build | — | TypeScript/Vite dependencies absent; no install authorized |

Exact owner-host commands using the existing provisioned dependencies (do not install anything as part of this handoff):

```bash
npm run build:core
npx tsc -p apps/api/tsconfig.json --noEmit
npm run typecheck
npm run build:web
npm test -- tests/factory-masked-correction.test.ts tests/web/capture-panel.test.tsx tests/web/masked-correction-panel.test.tsx
node --experimental-transform-types --test tests/capture-state-machine.test.mjs tests/factory-masked-correction-pure.test.mjs tests/masked-correction-ui-pure.test.mjs tests/factory-data-recovery.test.mjs
```

Core must be rebuilt before API typechecking; root `npm run typecheck` alone omits the API project. No `NOT RUN` result above is a pass by inference.

## G1–G12 status after bounded re-audit

| Goal | Current status | Remaining gate |
|---|---|---|
| G1 optional/mixed inputs, priority, locks, order | Existing implementation retained | Owner browser/semantic planner quality; local_llm runtime remains gated |
| G2 audio-only transcription/review/alignment | API/UI/fixture adapter retained | Real local ASR, independent transcript accuracy/alignment and listening review |
| G3 local picture understanding/reference conditioning | Adapters/UI retained | Real SD/vision runtime, conditioned outputs and visual-quality acceptance |
| G4 text/image/page storyboard ingestion/editing | Existing bounded parser/editor retained | Owner-document PDFs and real-browser ingestion |
| G5 seven editable visual families | Procedural implementation and prior bounded accepted slices retained | Whole-family meaning/direction/episode/quality and owner renders; not generated video/3D |
| G6 generated moving video/3D/talking characters | **BLOCKED** | Separate scoped engine authorization, integration and accepted real outputs |
| G7 image/reference quality + masked correction | Validation/durable lifecycle/UI implemented; host suites pending; engine **BLOCKED** | Current type/build/HTTP/DOM/browser checks; verified inpainting adapter and real visual acceptance |
| G8 natural Arabic/local speech independence | Adapters retained; natural engine **BLOCKED** | Authorized Arabic engine, licence/runtime and owner listening review |
| G9 new audio sync/translated text/cue timing | Existing implementation retained | New owner recording, independent language/listening/timing review |
| G10 in-app consented capture | Phase/lifecycle implementation + 31/31 PURE | 29 component cases, type/build and real consented browser capture/review |
| G11 readiness/budgets/cancel/restart/cache/resources | Existing paths + bounded masked jobs + offline recovery implemented | Host fault/restart/resource checks and offline recovery drill |
| G12 final matrix/accepted files/recoverable release | **IN PROGRESS / OWNER-HOST REVIEW PENDING** | Current integrated verification, actual output/creative/listening review and owner release decision |

## 11 input rows

| # | Input | Implementation/runtime status |
|---:|---|---|
| 1 | No material | Topic starter/local_rules implemented; semantic local planner and owner review open |
| 2 | Topic only | Three treatment directions implemented; semantic diversity and owner render review open |
| 3 | Script only | Exact-source/derivative review paths implemented; speech/render approvals open |
| 4 | Audio only | Transcription/review contract implemented; real ASR/alignment/listening open |
| 5 | Pictures only | Ordered silent/reviewed narrative and roles implemented; owner render/narrative review open |
| 6 | References + topic/script | Conditioning adapter implemented; real pixel-conditioned output unproven/blocked |
| 7 | Text storyboard | Import/ids/locks/conflicts implemented; owner browser/render open |
| 8 | Image/page storyboard | Ordered import/bounded PDF parser implemented; owner PDFs/browser open |
| 9 | Video with audio | Explicit original/add/replace/silent and measured mux paths implemented; owner media/render/audio review open |
| 10 | Video without audio | Silent/optional narration implemented; owner render/narration review open |
| 11 | Mixed/conflicting sources | Authority/locks/revisions/conflict retention implemented; owner browser/render open |

No-narration remains a valid explicit path; no voices/transcript/alignment gate or fabricated subtitle words are added.

## Seven visual families + separate real-engine rows

| Family/capability | Status |
|---|---|
| Motion-graphics explanation | Procedural/editable; owner whole-family render/quality review open |
| Procedural 2D actors/actions | Procedural/editable with bounded accepted slices; not generated video/3D |
| Illustrated narrative | Procedural/still/kinetic implementation; owner episode/religious/quality review open |
| Real screen tutorial | Requires real supplied/consented recording; G10 browser acceptance open |
| Footage documentary | Requires supplied footage; owner media/render/audio review open |
| Kinetic typography | Procedural/editable with bounded accepted slices; whole-family quality open |
| Mixed scenes | Existing mixed-treatment/editor implementation; owner episode/render review open |
| Generated moving video | **BLOCKED — no accepted real engine/output** |
| 3D | **BLOCKED — no accepted integrated engine/output** |
| Talking characters/natural output | **BLOCKED — adapter names are not accepted natural talking-character output** |

## Changed paths

The authoritative full rollback/path table is `ROLLBACK_MANIFEST.md`. The package comprises:

- API/core: `apps/api/src/routes/factory.ts`, `apps/api/src/server.ts`, `apps/api/src/services/factory-service.ts`, `apps/api/src/services/masked-correction.ts`, `apps/api/src/services/masked-correction-contract.ts`, `packages/core/src/factory/contract.ts`.
- Web: `apps/web/src/components/factory/CapturePanel.tsx`, `apps/web/src/components/factory/MaskedCorrectionPanel.tsx`, `apps/web/src/lib/capture.ts`, `apps/web/src/lib/factory-api.ts`, `apps/web/src/lib/masked-correction.ts`, `apps/web/src/pages/ContentPlan.tsx`.
- Recovery: `scripts/factory-data-recovery.mjs`, `tests/factory-data-recovery.test.mjs`.
- Tests: `tests/capture-state-machine.test.mjs`, `tests/factory-masked-correction-pure.test.mjs`, `tests/factory-masked-correction.test.ts`, `tests/masked-correction-ui-pure.test.mjs`, `tests/web/capture-panel.test.tsx`, `tests/web/masked-correction-panel.test.tsx`.
- Evidence: `docs/execution/factory-closeout/AUTHORITY_EVIDENCE_MATRIX.md`, `docs/execution/factory-closeout/ENGINE_OWNER_DECISION_SHEET.md`, `docs/execution/factory-closeout/RELEASE_GUIDE.md`, `docs/execution/factory-closeout/ROLLBACK_MANIFEST.md`, `docs/execution/factory-closeout/STATUS.md`, `docs/execution/factory-closeout/orders/VF-20261107-UNIFIED-CLOSEOUT04.md`, and `docs/execution/factory-closeout/ARENA_UNIFIED_CLOSEOUT04_DELIVERY_2026-11-07.md`.

No dependency/lockfile, renderer, owner-media/timing, credential, model, private output or machine-config path was changed. Test images existed only as generated in-memory fixtures; recovery files were disposable temp data and removed. There are no new rendered/captured/inpainted deliverables to claim or provide provenance for.

## One finite owner-host checklist

1. Fetch the fixed session branch, confirm the reported delivery SHA/ancestry and inspect only the listed diff; preserve any newer owner work.
2. Run the six exact verification commands above. Record core/API/web/build results and the 22 + 29 + 9 cases separately; repair any defect before continuing.
3. On disposable data, run the documented backup/verify/restore drill and confirm hashes plus nonempty-destination refusal. Do not restore over live owner data.
4. In a real browser on an owned synthetic screen, verify permission denial/cancel/late grant, repeated Stop, nonempty Stop→Record refusal, upload confirmation, failure/retry, Discard, Capture-another and unmount track/timer cleanup. No automatic consent or private upload.
5. With no production masked runner configured, open ContentPlan and verify mask editing/local validation, explicit readiness gate, persisted-job/error display and that no engine success is claimed. Run the real-route/component fixture suites only as labelled tests.
6. Review current source/diff and recovery/rollback instructions. Only the owner review agent may record acceptance/advance the approved branch; Arena does not deploy or merge.
7. Separate scoped decisions remain for real inpainting, vision/conditioning, local planner/ASR, natural Arabic, generated video and 3D. If authorization is later granted, configure the exact adapter/artifact and produce the decision-sheet acceptance output; those engine gates are not part of the 72 PURE/recovery passes and are not closed by this checklist.
