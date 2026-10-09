# Post-VS7 correction handoff

Scoped correction on `arena/c4cc1417-video-factory`. No render, no speech, no model download, no import of the real recording, no acceptance command, no publish, and no merge to `main`.

## SHAs

| | |
|---|---|
| Required source | `de063cca105ea7c454d3e2df60d9c0b1eb68acee` |
| Behavior commit | `1977e66ce109e1ffeb1f13cfff3c5c750270c5a9` |
| Behavior remote, independently fetched | `1977e66ce109e1ffeb1f13cfff3c5c750270c5a9` |
| Handoff commit | the child of `1977e66` that adds this file |

This file cannot contain its own commit SHA. After the docs push, `git rev-parse HEAD` and `git rev-parse origin/arena/c4cc1417-video-factory` must match. That tip is the final HEAD. The delivery note records the fetched value.

## What changed

- `packages/core/src/scenario/external-narration.ts` — intended spoken-script identity, distinct from the imported transcript digest.
- `apps/api/src/routes/external-narration.ts` — readiness supplies the current intended digest and does not rewrite the import.
- `apps/api/src/services/export-snapshot.ts` — project and audio identity compared across the async export boundary.
- `apps/api/src/services/external-audio-gate.ts` — allowed gate returns the identity it validated.
- `apps/api/src/routes/projects.ts` — final export rejects a mismatch and renders a reload of the validated identity.
- `tools/chatterbox/worker.py` — `perth`, no unsupported `device` argument, explicit multilingual v3 or refusal.
- `tools/provision-chatterbox.mjs` — `--apply` refuses to write a v3 marker when the installed loader cannot select `t3_model`.
- `packages/core/src/scenario/chatterbox-worker-protocol.ts`
- `packages/core/src/scenario/chatterbox-voice-identity.ts`
- `packages/core/src/scenario/chatterbox-dialogue-synthesizer.ts`
- `tests/fixtures/chatterbox-fake-worker.py`
- `tests/helpers/chatterbox-worker-fixtures.ts`
- `tests/voice-audio-api.test.ts` — multilingual fixture marker now reports `modelVariant: 'v3'`.
- `tests/chatterbox-worker-contract.py`
- `tests/chatterbox-worker-contract.test.ts`
- `scripts/ffprobe-resolution.ts`
- `scripts/external-narration-acceptance-plan.ts`
- `scripts/tsconfig.json`
- `tests/ffprobe-resolution.test.ts`
- `tests/external-narration-acceptance-plan.test.ts`
- `tests/external-narration-api.test.ts`
- `tests/external-narration-core.test.ts`
- `DEPENDENCIES.md`
- `tools/chatterbox/README.md`

## 1. Script invalidation

**Reproduction, before the fix.** After import, storyboard regeneration, listening approval, and timing approval, ordinary `PUT /api/projects/:id` with `{ input: { script } }` left the Long gate `exportAttemptReady`. The stored import transcript was unchanged. Approval identity was the import record, not the project's current spoken script.

**Cause.** `PUT` replaces `input` and updates `updatedAt`. The readiness check compared `approval.scriptSha256` with `import.scriptSha256`. A project-script edit does not rewrite that import field, so the old approval stayed current.

**Fix.** `externalNarrationIntendedSpokenSha256` is a separate digest.

- Long: schema `external-narration-intended-spoken/v1`, target `long`, the project script, and that target's scene narration.
- Short: the same schema and that Short's own narration only. The Long script is not hashed into a Short, so a legitimately different Short narration is not compared with Long text.
- Caption text and scene timing are not part of this digest.
- The imported file's `scriptText` and `scriptSha256` are not rewritten to manufacture a match.
- A supplied current digest that differs from the stored `intendedSpokenSha256`, including an approval written before this field existed, is `IMPORT-APPROVAL-STALE-INTENDED-SCRIPT`.
- Omitting the current digest keeps the previous comparison. Callers that evaluate readiness supply it.
- Restoring the same project script and the same narration text reproduces the same digest. That does not require a new recording.
- Storyboard regeneration does not rewrite an approval. If the regenerated narration still differs, the approval stays stale. If it matches, the approval remains valid.
- A caption-only correction does not change the intended digest, so listening approval and ownership consent stay. Timing approval is bound to the speech-timing revision and becomes stale.
- A timing-only edit keeps listening approval and consent. Timing approval does not stay ready.
- An unrelated target is not invalidated.

**Regression.** The ordinary-PUT case failed before the fix and passed after it. Save/reload, storyboard regeneration, restore, caption-only, timing-only, and the unchanged Short are covered in `tests/external-narration-api.test.ts` and `tests/external-narration-core.test.ts`. After the fix, the ordinary save blocks with `IMPORT-APPROVAL-STALE-INTENDED-SCRIPT` and not `IMPORT-APPROVAL-STALE-SCRIPT`. Restore plus regeneration clears that code and keeps listening approved. The declared transcript in the fixture stayed `STORY`.

## 2. Export coherence

**Risk.** Not a demonstrated live race. The handler loaded `p`, awaited the external gate (which reloads and measures audio), then rendered the earlier object and resolved audio from the path again. A script edit or a file replacement during that await could be checked against one state and consumed from another.

**Fix.** `identityOf` is `projectId`, `updatedAt`, SHA-256 of `input.script`, and, for every target, the narration ref plus the SHA-256 of the file at that path. The gate reloads after its own await and returns the identity it allowed. The handler compares that identity with a fresh read before starting the job. The job compares again before resolving audio and again after resolving audio, then renders the reloaded project. A mismatch is HTTP 409 before a job, or a job error before `exportProject`. It does not apply a newer gate to older content, and it does not follow a replaced file through an unchanged path.

QC still runs. A QC override does not bypass the external-narration gate. Preview is not this check. A project with no import is unchanged.

**Tests.** Deterministic hooks mutate the project or replace the audio at the async boundary. The renderer is mocked and records no call on rejection. Covered: change during validation, change after the gate returns, and a reload so a non-identity `topic` edit is what the mocked renderer sees. No real render.

**Remaining limits.** This is a compare-and-reject, not a lock and not a copied byte snapshot. `resolveTargetAudio` still returns paths. A replacement after the last pre-render digest check, while the renderer is reading that path, is not frozen out. Two final exports are not serialized against each other. `updatedAt` is part of the identity, so an ordinary save during the check rejects even when the spoken script is unchanged.

## 3. Chatterbox worker

Comparison only, not a pin change: Chatterbox `5de7a54aa4e5e2baadb0182dde554908b48b85c2` and Perth `ff1c8ac55a976971245cdd53c18d6131ca00d993`. The Perth source URL returned 404. Nothing here replaced `chatterbox-tts==0.1.7` or downloaded weights.

**Watermark.** The worker imported `resemble_perth`. The published module is `perth`. A probe with `perth` present and a non-null watermarker returned false. The check now imports `perth`. A missing module or a null watermarker still refuses the clip. Library presence is not treated as proof that a file was watermarked.

**Generate arguments.** The worker passed `device="cuda"` into `model.generate`. Upstream multilingual `generate` has no `device` argument; device belongs to model init. The probe failed on the unexpected keyword. `device` is now passed only when the loaded `generate` accepts it. Requested settings that the function accepts are still passed. An unsupported setting is still a refusal, not a silent drop.

**Variant.** The contract says multilingual v3. `from_pretrained(device=device)` with no variant is the v2 default, including on the pinned 0.1.7 loader, which has no `t3_model` parameter. The worker now requires `t3_model="v3"` for `chatterbox-multilingual-v3` and refuses a loader that cannot select it. It does not fall back to v2 and does not label v2 weights as v3. Offline loading uses the cached snapshot with that variant when `from_local` accepts it. A reported variant or revision mismatch is `MODEL_REVISION_MISMATCH`. Turbo has no variant. The reuse digest includes `modelVariant`. A missing or non-v3 worker report or marker does not silently change an approved voice's engine identity.

`--apply` throws before writing a v3 marker when the installed loader's `from_pretrained` does not accept `t3_model`. That refusal was not executed, because `--apply` downloads weights. Check mode was not changed into a hard failure.

**Contract tests.** `tests/chatterbox-worker-contract.py` imports `tools/chatterbox/worker.py` and calls its real functions with stub modules. No torch, CUDA, weights, or inference. Covered: `perth` plus a watermarker, missing module, missing watermarker, CUDA generation against the supported signature, supported and unsupported settings, explicit v3, and variant or revision mismatch with no fallback. The pinned no-`t3_model` loader is refused. The relevant pre-fix worker failed these calls; `test_unsupported_setting_is_not_silently_dropped` passed both before and after and is not an open defect. The fake-worker integration tests remain. The Vitest wrapper sets `PYTHONDONTWRITEBYTECODE=1`, and the Python file sets `sys.dont_write_bytecode` before the import, so `tools/chatterbox/__pycache__` is not created. The doctor test requires that directory to be absent.

## 4. Later acceptance duration

The later recording is Gemini `rahman_raheem_narration.wav`, 58.84 seconds, PCM16 mono 24 kHz. It is outside this sandbox. It was not fabricated, requested, generated, or imported. Accepted pronunciation is not commercial-rights clearance. Slima is not a prerequisite.

The planner default stays 20–30 seconds. It does not become unbounded. `--duration-min 58 --duration-max 60` is the explicit finite bound for that recording. One side, non-finite, negative, inverted, under 1 second, over 180 seconds, or a span over 5 seconds is rejected. Measured duration is compared with the stored imported duration, within the existing half-second tolerance. Digest, listening, ownership, and timing checks stay. One Long final export, no Shorts, no QC override, no automatic retry. The planner does not grant approval, import audio, or modify project state.

ffprobe resolution order is `BUILDTRAKE_FFPROBE`, then `BUILDTRACK_FFPROBE`, then `PATH`, then the app's bundled `ffprobe-static`. Both configured names still work. The resolver does not import the API platform, so it does not freeze environment or data paths. A probe does not provision or download. Failure returns null, does not guess a duration, and the diagnostic does not include the configured path.

## Local checks

These are local. They are not the GitHub result.

- Before the bytecode fix, `BUILDTRACK_CI_LANE=non-render npm test` was 1577 passed, 1 failed, 5 skipped (1583). The only failure was the doctor test seeing `tools/chatterbox/__pycache__` after an import of the worker. That cache was removed. The contract wrapper and the Python file now suppress bytecode.
- After that fix, `BUILDTRACK_CI_LANE=non-render node scripts/assert-test-count.mjs` printed `Tests passed: 1578`, `Tests failed: 0`, `Test files: 408`, and `ok - 1578 tests passed, at or above the floor of 300`. The JSON reporter did not print a skipped count. The preceding human-reporter run had 5 skipped, including the expected unprovisioned Kokoro A6 skip. The floor was not lowered.
- `npm run build:core` and `npm run build:web` passed. The existing Vite duplicate-key warning in `packages/video/src/scenes/Explanations.tsx` was not touched.
- Strict `tsc --noEmit` passed for `packages/core`, `apps/web`, `apps/api`, and `scripts`. Push CI typechecks core and web only. API and `scripts/tsconfig.json` were typechecked locally.
- `git diff --check` was clean before the behavior commit.
- An earlier 300-second suite run timed out and is not evidence. `fatal: not a tree object` appeared in local stderr and did not fail a test.

Not claimed from these checks: human listening, real Chatterbox inference, browser acceptance, or a correct MP4.

## GitHub checks

Non-render CI for the behavior commit: [run 37887065147](https://github.com/engmelkhabery1982/Video-Factory/actions/runs/37887065147).

- Conclusion: `success`
- Head SHA: `1977e66ce109e1ffeb1f13cfff3c5c750270c5a9`
- Job `Test, typecheck and build` (`113679330123`): success, about 9m10s
- Every listed step succeeded, including Python 3.11, core typecheck, web typecheck, the test suite, the production build, and the test-count guard
- Created `2026-10-09T05:07:25Z`, job completed `2026-10-09T05:16:38Z`
- The raw job log was not read. This sandbox cannot fetch the Actions blob host. No GitHub test count is claimed.
- Render checks were not dispatched. This is not a production-render pass.
- Annotations were the existing Node.js 20 deprecation notice and the Ubuntu 26 runner-image notice. They did not fail the job.

The docs commit that adds this file starts a later CI run because the workflow triggers on push. That later run is not the behavior result above. It was not cancelled and was not re-run by hand.

## Supported Chatterbox assumptions

- Package pin remains `chatterbox-tts==0.1.7`. It was not upgraded.
- Watermark dependency remains `resemble-perth`. The import name used by the worker is `perth`.
- Engine contract `chatterbox-multilingual-v3` promises variant `v3` and file `t3_mtl23ls_v3.safetensors`.
- The pinned 0.1.7 `from_pretrained(device)` does not accept `t3_model` and would load v2 if called. The worker and `--apply` refuse that call. They do not treat version string `0.1.7` as proof of v3 support.
- A source build that accepts `t3_model` must load `v3` from the intended cached revision. There is no v2 fallback.
- Turbo has no variant.
- Device is a model-init argument. It is not sent to `generate` unless that function's signature accepts it.
- No weight file was downloaded, and no real model was loaded, in this correction.

## Remaining real-runtime checks

- Provision and load a build that actually accepts `t3_model="v3"`, from the intended cache, and confirm the loaded file is `t3_mtl23ls_v3.safetensors`.
- Confirm a generated clip passes a real Perth watermark check. The offline stub only proves the worker calls the watermarker and refuses when it is missing.
- Confirm CUDA init on a machine with a GPU. The contract test stubs `generate`; it does not use CUDA.
- Human listening of `rahman_raheem_narration.wav`, a real ownership declaration, and a timing approval in the browser.
- One real Long export after those approvals. That MP4 was not produced here.

## Later acceptance command

Do not run this until the actions in the next section are done. This correction did not run it.

```bash
git checkout 1977e66ce109e1ffeb1f13cfff3c5c750270c5a9
node --import tsx scripts/external-narration-acceptance-plan.ts \
  --project <project-id> \
  --audio <path-outside-this-repo>/rahman_raheem_narration.wav \
  --duration-min 58 \
  --duration-max 60 \
  --base http://127.0.0.1:3000 \
  --confirm-single-export
```

Use the final remote SHA if it is newer than `1977e66` and contains this planner. The `<path-outside-this-repo>` placeholder is intentional. Do not substitute a path inside the repo, a symlink, or a `voice-audio` path. Without `--confirm-single-export` the command does not contact export. With it, the command sends one `POST /api/projects/<id>/export` body `{ "kind": "final", "includeShorts": false }` and no `override`, then polls `GET /api/jobs/:jobId`. HTTP 409 stops it. A finished job is not publication approval.

## User actions still required before that command can export

1. Check out the final remote SHA of this branch and use that tree for the command.
2. Keep `rahman_raheem_narration.wav` outside the repository. Do not cut it, generate a replacement, or import it from a `voice-audio` path.
3. Start the local API. Import that exact file through the existing outside-narration path for the Long target.
4. Listen to the whole file and approve it again. An approval stored before this correction has no `intendedSpokenSha256`. Once readiness supplies the current digest, that old approval is `IMPORT-APPROVAL-STALE-INTENDED-SCRIPT`.
5. Record the existing ownership declaration. Accepted pronunciation is not commercial-rights clearance, and this correction does not grant it.
6. Approve timing against the current speech timing. A later caption or timing edit requires a new timing approval. Listening can remain if the spoken content and the audio bytes are unchanged.
7. Confirm the review is ready to attempt export and that publication is not approved.
8. Only then run the command above, with `--duration-min 58 --duration-max 60` and `--confirm-single-export`, and only if one Long final export is intended.
