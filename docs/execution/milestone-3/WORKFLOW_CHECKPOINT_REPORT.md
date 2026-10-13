# Milestone 3 — workflow checkpoint report

Status: **CHECKPOINT, NOT COMPLETE.** The factory is not declared complete. This report covers the
work committed on `arena/890ccb82-video-factory` after `c3de9d1`. It separates what is implemented,
what is proven only by fixtures or code-level checks, what is blocked, and what is still open.

Labels used below: **code-checked** (typecheck/build/unit), **fixture-tested** (labelled fixtures or
labelled provider doubles, no provider call), **HTTP-only** (real registered server, synthetic
fixtures), **blocked** (needs a browser, ffmpeg, numpy/fairseq2, or a live provider), **open** (not built).
Nothing here is live-provider, listening-review, or owner acceptance evidence.

## 1. What is done in this checkpoint

| Area | Work | Label |
|---|---|---|
| Alignment transcript provenance | `tools/alignment-run/ctc_greedy.py` (stdlib greedy CTC decode + provenance builder); `align_recording.py` transcript block; TS discards any transcript without accepted provenance; transcripts are never copied from the script | code-checked; unittest 8/8; TS 11/11 |
| Alignment verdict | excerpt check in `proposalStaleReasons`; transcript comparison in `finishAlignment`; discrepancy refusal in `acceptProposal`; "unverified" when no independent transcript | fixture-tested (editor-alignment-preview 26/26) |
| Sidecar timing binding (shorts) | `targets.ts` `readTiming` now requires a declared `audioSha256` matching disk and a declared `audioDurationSec` within the 0.05 s tolerance; same rule as `external-narration.ts` | fixture-tested (targets-sidecar-binding 7/7) |
| Caption language | `captionLanguage` on the document; one rule `selectCaptions`; render plan uses it, so **preview and export** (both through `editorDocumentToRenderPlan`, see `editor-preview.ts` → `renderEditorPreview`) show only the selected language; untranslated spoken cues are reported, never filled | fixture-tested (core 8/8, DOM 7/7, API 4/4) |
| Derived rewrite (factory) | `POST /api/factory/drafts/:id/derive` (201) and `POST .../review`; source byte-identical; derivative gets new draftId at revision 0; changed units origin `derived`, their speech cache entries deleted; `derivedFrom` provenance; scenes matched on `sourceUnitId`; review gate blocks apply; stale revision → 409 `FACTORY_REVISION_CONFLICT` | fixture-tested (factory-derive 5/5; web panel 5/5) |
| Video-with-narration path | supplied video asset + supplied audio + storyboard times apply to a canonical editor document; a video with no narration source is blocked and apply is refused | HTTP-only (factory-video-narration 2/2, synthetic fixtures) |
| Gemini cancel after success | a canceled job whose provider result arrives late never overwrites the result | fixture-tested (gemini-provider) |
| Excerpt-missing staleness | a null evidence excerpt hash against a current excerpt is `stale` | code-checked (sync-evidence-core) |
| Contract comment | `gemini-contract.ts` header now names `speechMetadata.style` as the API reference field (was `speech_metadata`); code unchanged | code-checked |

## 2. Verification run (this checkpoint, at the working tree before commit)

| Command | Exit / result |
|---|---|
| `npm run build:core` | exit 0 |
| `npm run build:web` | exit 0 (vite, 72 modules) |
| `tsc --noEmit -p packages/core/tsconfig.json` | exit 0 |
| `tsc --noEmit -p apps/api/tsconfig.json` | exit 0 |
| `tsc --noEmit -p apps/web/tsconfig.json` | exit 0 |
| `npx vitest run` on 39 targeted files (alignment, transcript, caption language, editor, factory, derive, video-narration, gemini, sync, external-narration, targets binding, web ContentPlan / derive / caption / sync / plan-flow / client contract) | exit 0; **39 files passed; 661 tests passed, 1 skipped** |
| `tools/alignment-run/test_ctc_greedy.py` (earlier run) | 8/8 (run with `PYTHONDONTWRITEBYTECODE=1` from now on) |

Not run and not claimed: browser acceptance (no Chromium), any ffmpeg/ffprobe render or frame
inspection (no binaries), the real alignment runner (numpy and fairseq2 are not installed, so
`create_decoder` is unverified), any live Gemini call, and the full test suite.

## 3. Six-input capability matrix (Phase 3)

| # | Input path | Reaches the same editable project and export? | Evidence label | Missing requirement or blocker |
|---|---|---|---|---|
| 1 | Brief only | No. Planner reports missing `script` and `speech` (blocked, never a silent success) | fixture-tested (planning) | Needs a script and a speech engine |
| 2 | Supplied script | Partial. Plan is built; speech needs an engine | fixture-tested | English-only robotic local engine; **no Arabic engine**; Kokoro and Chatterbox unavailable without provisioning |
| 3 | Supplied script and supplied audio, with storyboard times | Yes, for fixture audio | fixture-tested | Owner recording not run through real alignment |
| 4 | Supplied images, with brief or script | Partial. Library binding works | fixture-tested | Factory `missingAsset` gate **open**; shot-list binding with visible missing requirements **open** |
| 5 | Supplied storyboard, standalone | **Not evidenced** | open | No standalone storyboard evidence yet |
| 6 | Supplied screen recording, with narration | Yes, for synthetic fixtures | HTTP-only (2/2) | Boundary-frame inspection **blocked** (no ffmpeg); owner recording not tested |

Boundary-frame inspection for captions and highlights (not only a middle frame) is **blocked**: no
ffmpeg and no browser in this sandbox. No frames were inspected.

## 4. Work-order items still open (do not treat as done)

- Phase 2, derive: the exact additional provider-call count is not shown before confirmation, and
  `confirmSpeechCalls` is not wired into apply or speech.
- Phase 2, speaker turns: `FactorySpeaker` has no `deliveryStyle`; per-speaker voices with separate
  delivery style are not built. Two-speaker unary turns are not proven.
- Phase 2, selective regeneration with spend confirmation: the turn cache is keyed on text, so a changed
  line invalidates only its clip, but spend confirmation (`spendConfirm`, `confirmedSpeechCalls`) is absent.
- Phase 2, product mention: the field exists in `gemini-contract.ts`, `gemini-service.ts`,
  `GeminiPlanPanel.tsx`, and `factory-api.ts`. The educational-default and religious-forbidden rules are
  not yet verified end to end.
- Phase 2, asset binding and shot lists: `missingAsset` is absent in the factory. The shot-list route
  exists; its handler and JSON/Markdown export are not reviewed or proven. Apply-before-spend gating on
  missing assets is not proven.
- Apply path: idempotent apply and the partial-apply retry across restart and duplicate concurrent apply
  are not re-proven in this checkpoint (the turn cache has passing tests from earlier work).
- Sync: `sync-evidence.ts` dedicated unit tests beyond the core suite; real forced alignment on the owner
  recording; any independent transcript on real audio; trim/source-change invalidation on real audio
  beyond fixtures.
- Gemini live: structured-output acceptance (`responseFormat.text`, `APPLICATION_JSON`) is not proven
  against Google. No live calls were made. Budget unchanged: 2 text generations and 2 previews per QA session.
- Browser gate: blocked (no Chromium). No browser acceptance claimed.
- Owner-host checks: not run.

## 5. Integration overlap with owner's unpushed local fixes (`de545d0fe69e9d3047c0e052323c74488cffdddb`)

Status: **commit `de545d0` is not present in this sandbox clone** (`git cat-file` fails). This section is
based only on the owner's description. Nothing here is verified against that commit, and nothing claims
that `de545d0` is on origin. The owner's Windows checkout was not touched.

| Owner local fix (as described) | Overlap with this branch | Action required |
|---|---|---|
| Gemini 3.8 REST corrections | Touches `gemini-client.ts`, `gemini-service.ts`, `gemini-contract.ts` (this branch changed only the header comment in `gemini-contract.ts`) | Reconcile by hand; keep the owner's REST corrections |
| Extended voice catalog and delivery-style selection | `factory-speech.ts`, `factory-api.ts` voice mirror, and the speaker model (`FactorySpeaker` has no `deliveryStyle` here) | Preserve the owner's catalog and style; do not reset to the 28-voice list |
| Still-image pan overscan | Not touched in this branch | None expected; confirm when the commit is available |
| Explicit channel-logo visibility | Not touched in this branch | None expected; confirm when the commit is available |

## 6. Changed files in this checkpoint (uncommitted at the time of writing)

Source and tests:
apps/api/src/routes/{editor,factory}.ts; apps/api/src/services/{editor-alignment,factory-service,targets,vf-align-worker}.ts;
apps/web/src/components/editor/EditorTextPanels.tsx; apps/web/src/components/plan/GeneratedDraftPanels.tsx;
apps/web/src/lib/{editor-model,editor-types,factory-api}.ts; apps/web/src/pages/ContentPlan.tsx;
packages/core/src/editor/{document,operations}.ts; packages/core/src/factory/{contract,gemini-contract,planning}.ts;
tools/alignment-run/{align_recording.py,ctc_greedy.py,test_ctc_greedy.py};
tests/{alignment-transcript,caption-language,editor-caption-language-api,factory-derive,factory-video-narration,targets-sidecar-binding}.test.ts;
tests/web/{derived-rewrite-panel,editor-caption-language}.test.tsx; edits to tests/{editor-alignment-preview,gemini-provider,sync-evidence-core}.test.ts and tests/fixtures/fake-align-runner.mjs.

Docs: this file; `ARENA_DELIVERY.md` §14; `LOCAL_VERIFY_STEPS.txt` section N.

No `data/`, `output/`, saved timings, recordings, models, or dependencies are in Git. No manifest or lockfile change.
Dependency note: `npm ci --ignore-scripts` (lockfile-only install, disclosed).

## 7. Owner verify steps

See `LOCAL_VERIFY_STEPS.txt` section N. Nothing in this checkpoint requires a live key, a recording upload, or a paid call.
