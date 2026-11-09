# VF-20261108-UNIFIED-CLOSEOUT05 — continuous implementation package

## Status and exact source

**IMPLEMENTED / OWNER-HOST QUALIFICATION PENDING. WHOLE-FACTORY ACCEPTANCE IS NOT CLAIMED.**

- Repository: `engmelkhabery1982/Video-Factory`.
- Arena-required execution branch: `arena/da9e43e6-video-factory`. The owner-named `arena/dc133a86-video-factory` could not be used because this Arena session fixes the branch above; its reviewed source was fetched and preserved exactly.
- Initial provisioned HEAD: `b235b002df4cab2237ef0a8093b1aeef225f6903`.
- Required reviewed base and pre-edit parent: `59089ab47c943245909bcf673c4e2d468942d002` (`fix(factory): qualify closeout04 and repair host integration regressions`).
- Base ancestry: `b235b00` was verified as an ancestor of `59089ab`; the branch fast-forwarded normally with `git merge --ff-only`. No reset, clean, forced checkout or force push occurred.
- Delivery parent/tip and pushed remote SHA are resolved with `git rev-parse HEAD`, `git rev-parse HEAD^`, and `git ls-remote --heads origin arena/da9e43e6-video-factory` immediately after the normal push and are reported in the final handoff. This document does not invent a self-referential commit hash.
- Accepted authority `review/owner-approved @ daae482aac9de85e993599a6d010e29908ac567a` was retained, not advanced. No main merge, deployment, publication or owner/F promotion occurred.

## Implemented code, not merely a blocked label

### G3/G7 — verified existing sd-cli inpainting interface and canonical import

The new `masked-correction-sd-cli.ts` and dependency-free `masked-correction-sd-cli-contract.ts` complete the previously missing production adapter/registration/import path against the **existing** local `stable-diffusion.cpp` CLI family. No new engine, model, provider or dependency was introduced.

The exact upstream interface was inspected through GitHub at commit `1d0a58a35050d285b1d6fb1bc68a92924d35825e`:

- `examples/common/common.cpp`: `--init-img`, `--mask`, `--strength`, prompt/dimensions/seed/steps/output flags.
- `examples/cli/main.cpp`: frozen init image and one-channel mask loading; explicit source-sized generation/output.
- `src/pipeline/image.cpp`: mask values are rounded; `1` is the region supplied to the inpainting model.

Implementation details:

1. **Opt-in readiness and registration.** `MASKED_CORRECTION_ENABLED=1` is separate from ordinary still generation. The adapter may reuse `LOCAL_IMAGE_RUNNER`, but never its base model. A distinct inpainting model path and actual SHA-256 are mandatory. Production accepts only the two recorded upstream artifact hashes. Real `sd-cli -h` output must contain every flag used. Invalid/partial setup remains unconfigured with actionable diagnostics. Startup and every run verify the setup.
2. **Strict pixels.** Canonical rectangles become a complete non-interlaced 8-bit grayscale PNG. Black is preserved source; white is the exact union to inpaint. Overlaps remain binary. No arbitrary mask string or client path reaches the CLI.
3. **Source protection and provenance.** The runner uses frozen verified original bytes in a dedicated per-run directory. The original library file is never overwritten. Run-specific result ids prevent provenance reassignment between jobs. Canonical import records source/result/model/mask hashes, job/run/draft/scene ids, prompt/negative-prompt hashes, seed/settings/dimensions and the verified interface commit. Unchanged result bytes are refused even under another asset id.
4. **Lifecycle/resources.** Arguments are spawned directly, never through a shell. Output is size-bounded and fully PNG-validated at exact original dimensions before import. Cancellation kills the child; late/corrupt output is not imported. Per-run scratch is removed in `finally`. Configured startup removes only dedicated scratch after the existing busy guard, never canonical results. Existing durable jobs, retry budgets, idempotence, stale-target fingerprints, review and same-lock Apply/reconcile remain in force.
5. **Honest doubles.** `createMockRunner` remains fixture-only. The fake CLI is only runnable under Vitest, is labelled in job readiness/provenance, and cannot be registered outside it. No fake output is called real inpainting.

The exact host environment contract is in `RELEASE_GUIDE.md`; no local machine configuration was committed.

### G10 — actual captured-media review and resource cleanup

The existing consented `MediaRecorder` flow now creates a local object URL from the actual stopped `Blob` and presents non-autoplay `<video controls>` or `<audio controls>` before upload. It is retained through upload failure and after upload for review. Discard and unmount revoke the URL. Existing permission, start/stop, retained-chunk, retry, upload and track/timer cleanup protections remain unchanged. Browser-API and object-URL doubles remain DOM evidence only; no native screen/microphone was accessed.

### G11/G12 — recovery and coherent handoff

The sd-cli child/scratch lifecycle is integrated with the existing bounded masked-job recovery. The living matrix, engine sheet, release guide and rollback manifest distinguish implementation, fixture, unrun host checks, real engines and acceptance. Offline backup/restore code was not changed; its reviewed evidence is retained, including 8 pass/1 privilege-dependent file-symlink skip and the actually passing Windows junction case.

## Executed evidence in this sandbox

`node_modules` is absent. No installation, download, provisioning or `npx` bootstrap was attempted.

| Label | Exact command | Result | Meaning / limit |
|---|---|---:|---|
| PURE | `node --experimental-transform-types --test tests/masked-correction-sd-cli-contract.test.mjs` | **9 pass / 0 fail / 0 skip**, exit 0 | Exact mask pixels/union/PNG CRC/argv/artifact pins; no server or engine |
| PURE affected aggregate | `node --experimental-transform-types --test tests/masked-correction-sd-cli-contract.test.mjs tests/factory-masked-correction-pure.test.mjs` | **36 pass / 0 fail / 0 skip**, exit 0 | New 9 plus affected existing 27 strict-mask cases |
| Syntax only | `node --experimental-transform-types --check` on changed non-TSX server/client/test TypeScript | exit 0 | Parse only; **not typechecking or TSX compilation** |
| Fixture syntax | `node --check tests/fixtures/fake-sd-cli.mjs` | exit 0 | Parse only |
| Whitespace | `git diff --check` | exit 0 | No whitespace errors |

The final changed-file syntax/whitespace commands and counts are also recorded in the final handoff. No dependency-based test was represented as executed.

### Reused reviewed evidence — not rerun without a relevant delta

- CLOSEOUT04 host core rebuild, API/core/web typechecks and web build passed at the reviewed base.
- CLOSEOUT04 host affected Vitest was 129/129; Node was 72 pass/1 skip. These are historical bounded results, not current CLOSEOUT05 results.
- Real browser mask validation and the unconfigured-runner gate were exercised by the owner on disposable loopback QA. No real correction job or engine ran.
- Existing valid procedural render evidence and recovery evidence were not repeated.

## Written/changed but NOT RUN here

| Suite/check | Current scope | Exact blocker |
|---|---:|---|
| `tests/factory-masked-correction.test.ts` | **28 cases**: real routes/store, mocks plus fake-CLI registration/import/Apply/cancel/corrupt/missing-flag/unchanged-byte cases | Vitest/Fastify/project dependencies absent |
| `tests/web/capture-panel.test.tsx` | **32 cases**: actual React component with browser-API/object-URL doubles, including video/audio review and URL cleanup | Vitest/happy-dom/TSX toolchain absent |
| `tests/web/masked-correction-panel.test.tsx` | **10 cases**, including late Apply and setup fixture compatibility | Same |
| `tests/local-image.test.ts`, `tests/local-image-freshness.test.ts`, `tests/factory-visual-review-http.test.ts` | Existing **62-case** affected shared fake-CLI/local-image surface | Same; historical 62/62 is not reused as current proof after changing the fixture help contract |
| Core rebuild, API types, core/web types, production web build | Current tree | TypeScript/Vite dependencies absent |
| Real sd-cli inpainting | Adapter and authorized artifact on owner host | No runtime/model/artifact exists here and no new provisioning is authorized |
| Native capture, browser output, listening/quality | Owned synthetic surface and owner review | No real browser/media consent/output path here |

## Required current-tree host verification

Use existing installed host tools only; do not install as part of this handoff. Rebuild core before API types:

```bash
npm run build:core
node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noEmit
npm run typecheck
npm run build:web
npm test -- tests/factory-masked-correction.test.ts tests/web/capture-panel.test.tsx tests/web/masked-correction-panel.test.tsx tests/local-image.test.ts tests/local-image-freshness.test.ts tests/factory-visual-review-http.test.ts
node --experimental-transform-types --test tests/masked-correction-sd-cli-contract.test.mjs
```

Record suites/counts separately: expected current test-file scopes are 28 + 32 + 10 + 62, not one claimed aggregate until executed. Any failure must be repaired without weakening assertions. The file-symlink skip is not a pass.

## G1–G12 matrix after implementation

| Goal | Implemented/current evidence | Still open, not certified |
|---|---|---|
| G1 optional/mixed inputs, authority/locks | Existing 11-input canonical draft/editor implementation retained | Browser/semantic-planner quality and owner acceptance |
| G2 independent transcription/review/alignment | Existing independent runner/review/alignment contracts retained | Real local ASR, independent accuracy/alignment and listening; transcript is not alignment |
| G3 vision/reference conditioning | Existing adapters/UI retained | Real vision/pixel-conditioned output and visual quality |
| G4 text/image/page storyboard/edit | Existing text/JSON/bounded PDF/edit/conflict flow retained | Owner PDFs, browser ingestion and output review |
| G5 seven editable visual families | Existing procedural/still/supplied-footage implementations retained | Meaning-led whole-family output/quality/episode review; not generated video/3D |
| G6 generated video/3D/talking characters | No false substitute added | Separate authorized engines, integration and accepted real outputs |
| G7 image/reference quality/masked correction | **Opt-in sd-cli adapter, registration, strict mask, canonical importer and captured lifecycle implemented; 9 new PURE passes** | Current host suites/types/build; authorized artifact; real corrected output and visual acceptance |
| G8 natural Arabic/local speech | Existing speech adapters retained | Natural Arabic engine, licence/runtime and listening; SAM robotic English is insufficient |
| G9 new audio sync/translation/cues | Existing narration/timing/export gates retained | New real recording, independent language/listening/timing review |
| G10 consented capture | **Actual Blob audio/video review + URL cleanup implemented** | Current 32 DOM-double cases, native consented capture/upload/retry/discard/resource review |
| G11 bounded/resilient daily use | Existing bounded jobs/recovery plus sd-cli child/scratch cleanup | Current fault/restart/resource checks and disposable offline recovery drill |
| G12 integrated release | Matrix/guides/rollback/current handoff updated | Current integrated output/quality/listening/recovery evidence and reviewer release decision |

## 11 input rows

| # | Input | Current state |
|---:|---|---|
| 1 | No material | Topic starter/local_rules implemented; semantic planner and owner review open |
| 2 | Topic only | Three treatment directions implemented; semantic diversity/render review open |
| 3 | Script only | Exact-source/reviewed-derivative paths retained; speech/render approvals open |
| 4 | Audio only | Independent transcription/review contract retained; real ASR/alignment/listening open |
| 5 | Pictures only | Ordered silent/reviewed narrative and roles retained; output/narrative review open |
| 6 | References + topic/script | Conditioning adapter retained; real conditioned output unproven |
| 7 | Text storyboard | IDs/locks/wording/times/conflicts retained; browser/render review open |
| 8 | Image/page storyboard | Ordered import/bounded PDF parser retained; owner PDFs/browser open |
| 9 | Video with audio | Original/add/replace/silent and measured mux retained; owner output/audio review open |
| 10 | Video without audio | Silent/optional narration retained; owner output/narration review open |
| 11 | Mixed/conflicting sources | Authority/locks/revisions/conflict retention retained; browser/render review open |

No-narration remains valid; no transcript/alignment gate or invented subtitle words were added.

## Seven visual families and distinct real-engine rows

| Family/capability | Current state |
|---|---|
| Motion-graphics explanation | Procedural/editable; whole-family output/quality open |
| Procedural 2D actors/actions | Procedural/editable; not generated video/3D |
| Illustrated narrative | Stills/procedural/kinetic implementation; religious/episode/quality review open |
| Real screen tutorial | Requires supplied/consented real recording; native G10 review open |
| Footage documentary | Requires supplied footage; output/audio review open |
| Kinetic typography | Procedural/editable; whole-family quality open |
| Mixed scenes | Existing canonical mixed editor/render path; episode/output review open |
| Generated moving video | **BLOCKED — no accepted real engine/output** |
| 3D | **BLOCKED — separate Blender proof is not factory integration** |
| Talking characters/natural output | **BLOCKED — adapter names/fixtures are not accepted natural output** |

## Changed paths

Source:

- `apps/api/src/server.ts`
- `apps/api/src/services/masked-correction.ts`
- `apps/api/src/services/masked-correction-sd-cli.ts` (new)
- `apps/api/src/services/masked-correction-sd-cli-contract.ts` (new)
- `apps/web/src/components/factory/CapturePanel.tsx`
- `apps/web/src/components/factory/MaskedCorrectionPanel.tsx`
- `apps/web/src/lib/factory-api.ts`

Tests/fixtures:

- `tests/factory-masked-correction.test.ts`
- `tests/fixtures/fake-sd-cli.mjs`
- `tests/masked-correction-sd-cli-contract.test.mjs` (new)
- `tests/web/capture-panel.test.tsx`
- `tests/web/masked-correction-panel.test.tsx`

Evidence/release:

- `docs/execution/factory-closeout/AUTHORITY_EVIDENCE_MATRIX.md`
- `docs/execution/factory-closeout/ENGINE_OWNER_DECISION_SHEET.md`
- `docs/execution/factory-closeout/PLAN.md`
- `docs/execution/factory-closeout/STATUS.md`
- `docs/execution/factory-closeout/RELEASE_GUIDE.md`
- `docs/execution/factory-closeout/ROLLBACK_MANIFEST.md`
- `docs/execution/factory-closeout/ARENA_UNIFIED_CLOSEOUT05_DELIVERY_2026-11-08.md` (this report)

No dependency/lockfile, renderer, owner media/text/timing/output/WAV, credential, model or local machine configuration was changed. No real result/capture/render artifact was produced, so there is no new output artifact or output hash to claim.

## Rollback and finite host completion checklist

Rollback is a new reviewed revert of the explicit CLOSEOUT05 delivery commit after preserving newer work. Disable any host masked-correction launch configuration and stop the server first. Source rollback never deletes drafts, jobs, canonical results, captures, models or backups; only dedicated `sd-cli/work` scratch is disposable. See `ROLLBACK_MANIFEST.md`.

1. Fetch the Arena-fixed branch, verify the reported tip/parent and exact `59089ab` ancestry; inspect the listed diff and preserve any newer work.
2. Run the current build/type/test commands above. Record API separately from root types and each test suite separately; repair failures rather than weakening tests.
3. Review adapter source and readiness with no configuration: submission stays blocked and setup details are truthful. With incomplete/bad config, verify no job starts and no scratch/active work is deleted.
4. Only with an already authorized exact inpainting artifact, configure the release-guide environment on disposable data. Run one owned still through mask → real local generation → original/result comparison → review → Apply → reopen. Verify original/result/model/mask hashes, job/run provenance, cancellation/retry and stale-target refusal. Inspect actual image quality; fixtures cannot close this.
5. In a real consented browser on an owned synthetic surface, verify screen and microphone capture, actual review playback, permission denial/cancel, empty capture, upload confirmation/failure/retry, Discard/Capture-another and track/timer/object-URL cleanup. Never capture the owner's screen/microphone implicitly.
6. On disposable stopped-server data, perform backup/verify/non-merging restore and confirm hashes/refusals. Retain the file-symlink privilege skip as skipped, not passed.
7. Reuse unaffected reviewed outputs, but perform the remaining owner semantic/render/listening/quality review before any operational-release or expanded-goal decision. Only the reviewer may promote the approved branch/F.
