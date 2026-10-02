# Pre-acceptance correction pass — handoff report

Status: **correction pass code-complete and locally validated; pushed as
`8509e51`. The single Final Product Acceptance run was NOT triggered in this
session (operator checkpoint), and GitHub workflow-dispatch permission is
currently unavailable from this sandbox anyway.**

## 1. Starting point

| | |
|---|---|
| Session branch (delivery branch) | `arena/01a0fc3d-video-factory` |
| Starting SHA (last audited head of `arena/final-product-acceptance`) | `3d9850b40d358cdf9a1ff5760a42a9faa6b61eab` |
| Parent of that head | `448a17e897a6604536cdd02454f285c12a9fa8eb` |
| `origin/main` at start and at end | `4816722adcea0002ab4701e764544ec265d5912a` (untouched) |
| `origin/arena/final-product-acceptance` at end | `3d9850b4` (untouched: no push, no force-push, no move) |

The corrections were made on the session branch and pushed normally
(fast-forward, no force):

| | |
|---|---|
| Corrections commit (pushed) | `8509e51b4097bac7bb88fe0a3bdb55a4b1c8c497` |
| Verified remote SHA (`git ls-remote origin arena/01a0fc3d-video-factory`) | `8509e51b4097bac7bb88fe0a3bdb55a4b1c8c497` (matches) |
| CI run for that push | `37002134260` — **passed** (validate: npm ci, build:core, strict core+web typechecks, `npm test`, `npm run build:web`, test-count guard) |

The audited branch name is not writable from this session (session branches are
fixed), so the acceptance run must be dispatched against this branch's head.

## 2. Files changed and why

### Acceptance driver / evidence (no product authority added)

| File | Why |
|---|---|
| `scripts/acceptance-audio-probe.ts` *(new)* | **A** — real audio probe (container/codec/sample rate/channels/duration/stream presence) replacing `analyseFile()` on WAVs. |
| `scripts/acceptance-stage-validation.ts` *(new)* | **H/I** — stage envelope + payload validation (run/commit identity, media sha256, Phase 6D manifest/checksums/summary, kit completeness, second-project state) and the exposure-window/sample-time maths. |
| `scripts/final-product-acceptance.ts` | **A/H/I/J/K** — per-turn + canonical WAVs probed as audio; multi-target plan build now also consumes the resolution DTO; frame proof samples inside the planned scene display window (audio-authoritative durations × resolved scene usages) with controls outside the window; every helper rechecked against its file type; second-project stage asserts a strict generation-only end state (no build, no MP4, no package, no kit, no readiness, `status === 'generated'`). |
| `scripts/acceptance-audio-identity.ts`, `scripts/tsconfig.json` | Audio-identity helper export + the new scripts added to the acceptance typecheck. |
| `.github/workflows/final-product-acceptance.yml` | **B** — run-id-pinned artifact chain: short-smoke restores the same run's preflight (identity + status + per-turn audio count verified), final-production restores preflight **and** short-smoke (both stage JSONs verified, real `.production` audio count must match preflight), state artifact carries `stage/final-production.json`, second-project verifies it, evidence job downloads every stage of the same run. Nothing is fabricated when a file is missing — the job fails. |

### Product corrections

| File | Why |
|---|---|
| `apps/api/src/services/production-state.ts` | **D/E** — edits drop the builds that contained the edited target and clear `productKitPath`; regeneration clears the kit link; new `invalidateDownstreamForInputChange()` (clears builds/artifacts/QC/readiness/kit, sets `needs_regeneration`); new `finalDeliverySucceeded()`; `recordBuild` only reports `ready_for_export` when render **and** package are ok. |
| `apps/api/src/services/production-engine.ts` | **D/E** — a final build that is not a genuine success ends `blocked`; `productionStatusFor` never reports `ready` for a failed/partial delivery. |
| `apps/api/src/routes/production.ts` | **D/E** — summaries suppress derived records for stale input, add `deliveryReady`, expose the resolution DTO on the multi-target build, and gate production history behind `productionHistoryEligible()` (final + genuinely successful delivery only). |
| `apps/api/src/routes/projects.ts` | **D** — saving a changed ProjectInput immediately invalidates the derived state; list summaries stop presenting stale builds/artifacts/readiness/kit. |
| `apps/api/src/services/production-deliverables.ts` | **G** — provenance keeps durable `assetId`/`logicalRef`/scene usage + `mediaRef` (`data/assets/...`) + sha256/size; per-job loopback URLs are runtime diagnostics and are never written into the kit; the manifest documents the policy. |
| `apps/api/src/server.ts` | **L** — binds `127.0.0.1` unless `HOST` is explicitly set; `buildServerApp()` is exported for route tests; every file route is containment-guarded; the vulnerable `@fastify/static` wildcard route is no longer registered (in-house SPA handler: regular files only, extension allowlist, no dotfiles, no listings, SPA fallback). |
| `apps/web/src/App.tsx`, `apps/web/src/lib/production-navigation.ts` *(new)*, `pages/Export.tsx`, `pages/Captions.tsx` | **M/D** — documented legacy-project policy (production state → production storyboard; legacy/unknown/failed read → legacy storyboard, never a broken fallback) and no stale builds/QC/readiness/kit presented as current. |
| `packages/core/src/scenario/synthesize-dialogue.ts`, `.../audio-synthesis-types.ts` | **F** — validated synthesis reuse keyed to spoken text + speaker/voice + engine/model + settings + target path, with sidecar size/sha256 validation; dialogue edits invalidate exactly the edited clip; `reuse: false` opts out. |
| `README.md` | **L/M** — documents the bind-host policy, the static-serving mitigation, the remaining `npm audit` exposure split (dev-only vs local TTS transitive), and the legacy-project policy. |

### Test infrastructure and tests

| File | Why |
|---|---|
| `tests/helpers/isolated-tmp.ts` *(new)* | **C** — per-suite isolated scratch directories with safe cleanup. |
| `tests/phase6b-plan-render.test.ts`, `tests/phase6b-real-render.test.ts`, `tests/dialogue-visual-production.test.ts`, `tests/final-product-integration.test.ts` | **C** — no suite deletes a shared `.test-phase6b` anymore; each uses (and removes only) its own directory. |
| `tests/acceptance-audio-probe.test.ts` *(new)* | **A** — valid WAV, invalid/malformed WAV, missing audio stream, missing/empty file. |
| `tests/acceptance-stage-validation.test.ts` *(new)* | **H/I** — envelope identity/status/run/commit, payload media/package/kit validation, second-project strictness, window maths and sample placement. |
| `tests/dialogue-synthesis-reuse.test.ts` *(new)* | **F** — reuse counts, byte identity, edit invalidation, tamper/missing detection, engine/voice change, `reuse: false`, sync variant, separate Long/Short file sets. |
| `tests/production-invalidation-delivery.test.ts` *(new)* | **D/E** — input change → invalidated persisted state + API summaries (and after reopen); scene edit / spokenText edit / binding change / regeneration; readiness gate truth table; production-history gate; stale sidecar cannot report ready. |
| `tests/production-kit-portability.test.ts` *(new)* | **G** — no loopback URL anywhere in the kit; durable ref + integrity; the kit still resolves after the data tree moves with no server running. |
| `tests/server-media-security.test.ts` *(new)* | **L** — default host, asset/output/SPA routes, encoded traversal, directory/dotfile denial, and the absence of the vulnerable static route in the runtime. |
| `tests/web-storyboard-navigation.test.ts` *(new)* | **M** — policy + real component mount for production/legacy projects, failed read fallback, and reopen/navigation between projects. |
| `tests/production-deliverables.test.ts` | Updated for the portable provenance contract. |
| `HANDOFF_PRE_ACCEPTANCE.md` *(new)* | This report. |

## 3. Non-render validation results (local)

| Check | Result |
|---|---|
| `git diff --check` | clean |
| `npm run typecheck` (core + web) | clean |
| `npx tsc --noEmit -p apps/api/tsconfig.json` | clean |
| `npx tsc --noEmit -p scripts/tsconfig.json` | clean |
| `npm run build:web` (production build) | passed (`dist/index.html` + hashed assets) |
| `npm run build:core` | clean |
| Focused non-render suites | all green — audio probe 7, stage validation 20, synthesis reuse 8, invalidation/delivery 8, kit portability 4, server/media security 6, storyboard navigation 5 |
| Broad non-render regression with normal parallelism | **1129 passed, 0 failed, 13 skipped**, 304 suites — `npx vitest run --exclude 'tests/phase6d-real-package.test.ts'` (that suite renders real MP4s through Remotion and needs a provisioned/system Chromium; it is excluded locally by design) |
| CI (full `npm test`, chromium available on the runner) | run `37002134260` — **passed**, including the 300-test floor guard |

No local render of a Long/Short product video happened. Nothing was
provisioned (`provision`, `provision:tts`, `demo*`, `stills`, `verify`,
`evidence*`, `voiceovers`, `seed`, `handoff`, `ui:shots` were never run). The
only media work locally was ffmpeg unit fixtures inside existing tests and
byte-level WAV fixtures in the new reuse tests; no Kokoro model and no Remotion
render was used.

## 4. Security review (npm advisories — no blanket `npm audit fix`)

| Advisory | Kind | Action |
|---|---|---|
| `@fastify/static` (high) | **runtime** | Runtime exposure removed: the wildcard static route is no longer registered; the SPA is served by the in-house handler above. An in-place upgrade is impossible because gate 20 freezes `package-lock.json`. Documented in `README.md`. |
| `vitest`, `@vitest/mocker`, `vite`, `esbuild` | development-only | Not shipped; left untouched (semver-major changes cannot be validated in this non-render pass). |
| `sharp`, `@huggingface/transformers`, `kokoro-js` (transitive) | local TTS engine | Reads only local model files and operator-supplied text; cache-only synthesis, no network fetch at synthesis time. |

Also fixed and tested: default bind host `0.0.0.0` → `127.0.0.1` (explicit
`HOST` still honoured), path-traversal containment for `/media/*` and
`/output/*`, directory paths never streamed, dotfiles and listings denied for
the SPA.

## 5. Workflow trigger — blocked, action needed

- The push to `arena/01a0fc3d-video-factory` did **not** trigger Final Product
  Acceptance (its push trigger requires the `.github/final-acceptance-run-once`
  marker path, which was not touched — and must not be touched).
- `gh workflow run final-product-acceptance.yml --ref arena/01a0fc3d-video-factory`
  → **HTTP 403 `Resource not accessible by integration`**. The Arena GitHub
  connection in this sandbox has no `actions: write` permission, so no dispatch
  (and no rerun of an older run) is possible from here.
- No Final Product Acceptance run exists yet for the pushed SHA (only the CI run
  above); using the run-once marker is prohibited, so nothing has been
  double-triggered.

**Needed (for the next session):** reconnect GitHub in Arena with Actions
access, or press **Run workflow** in the Actions UI for `Final Product
Acceptance` with branch `arena/01a0fc3d-video-factory`. Exactly one run should
be created for the head SHA at that time — no run has been created so far.

Per explicit operator instruction, this session stopped at the safe checkpoint
and did **not** trigger the acceptance workflow. The single dispatch attempt
recorded above was rejected by GitHub (HTTP 403) before any run or workflow event
was created, so the "exactly one run" requirement is still fully available.

## 6. Remaining limitations

**Product**

- Uploaded `audio/*` assets keep best-effort metadata (duration is not recorded
  for audio uploads); this never fails an upload and does not affect production
  per-turn/canonical audio, which is now probed as audio.
- The lockfile is frozen by the product's own gate 20, so the `@fastify/static`
  upgrade is deferred; the mitigation removes its runtime use instead.

**Acceptance / workflow**

- The Final Product Acceptance run is pending the permission fix above; per-stage
  results (preflight, short-smoke, final-production, second-project, evidence)
  are therefore not yet available.
- `tests/phase6d-real-package.test.ts` (real Remotion render) is excluded from
  local non-render validation; it passes in CI where Chromium exists.

## 7. Confirmations

- `origin/main` is untouched at `4816722adcea0002ab4701e764544ec265d5912a`.
- `origin/arena/final-product-acceptance` is untouched at `3d9850b4`.
- No force-push, no history rewrite, no branch move, no merge into `main`.
- `.github/final-acceptance-run-once` and `.github/phase6e-run-once` were not
  modified.
- The product's original requirements are intact: production authority
  (Scenario → production audio → Phase 5 → Phase 6A → Phase 6C → Phase 6D),
  real Kokoro audio, Phase 6D package, product kit, readiness QC and
  anti-repetition history all remain the authorities.
