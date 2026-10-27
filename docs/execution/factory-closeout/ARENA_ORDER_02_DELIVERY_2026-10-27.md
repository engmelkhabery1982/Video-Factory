# Arena Order 02 delivery — optional inputs, planning gates and PDF/video-audio entry paths

Date: 2026-10-27. Branch: `arena/f99ee528-video-factory`. Base: `eb0eac826a5b75a06dc3102380a6f54ac9201c71` (`review/owner-approved` tip at dispatch).
Status label: **IMPLEMENTED, PENDING OWNER REVIEW**. Arena does not mark anything owner-accepted. No provider call, model/download, dependency, manifest or lockfile was added.

## 1. What this increment adds

1. **No-material starting point.** Deterministic, rule-based topic suggestions (`packages/core/src/factory/topic-starter.ts`), labelled `local_rules` everywhere: no model, no provider, no generated scripture or fact. Route `GET /api/factory/topic-suggestions`; UI panel with "Use as the brief". A brief-only draft now carries an exact `plannerGate` (route `local_llm`, each missing setting named, `googleUsed:false`) and an actionable warning — never a bare "unavailable".
2. **Built-in PDF storyboard ingestion.** Zero-dependency parser (`apps/api/src/services/pdf-storyboard.ts`, node:zlib only) and multipart route `POST /api/factory/imports/storyboard-pdf` (`apps/api/src/routes/factory-imports.ts`). One panel per page in exact page-tree order, stable `page-NN` ids, extracted words, the first embedded DCT JPEG bound to its page (extras warned), null times/locks/speakers (never invented). Source and licence are mandatory; pictures enter the normal measured-upload library rules. The route creates **no draft** — the canonical `POST /api/factory/drafts` remains the single creation path.
3. **Explicit video-audio policy** (`original` / `replace` / `add` / `silent`). Uploads measure and persist `Asset.hasAudio` with ffprobe; plan-time rules (`packages/core/src/factory/video-audio-policy.ts`) turn measured facts into precise per-scene refusals or `keepAudioAssetIds`; the canonical editor document carries the project policy and per-clip `keepAudio`; the Remotion `OffthreadVideo` is unmuted only for kept clips; the export mux keeps, mixes or strips audio per the document and verifies the result with ffprobe. A clip that cannot be measured is refused as "could not be measured", never claimed silent. Null policy preserves the legacy muted-clip behaviour byte-for-byte.
4. **Web reachability.** New intake components (topic starter, policy radios, PDF importer, planner gate note) are mounted in the real `ContentPlan` page, with mirrored client types/methods and a multipart client call.

## 2. Input coverage matrix (positive production separated from refusals)

Evidence labels: **PURE** = pure unit (no I/O); **HTTP** = real route via app.inject; **DOM** = happy-dom (not a browser); **ENGINE** = real bundled ffmpeg/ffprobe or sam-js; **BROWSER** = real Chromium (not available here, see §5).

| Input path | Positive flow and evidence | Refusal / gate evidence | Unproven here |
|---|---|---|---|
| No material (topic starter) | PURE `tests/topic-starter.test.ts` 9/9 (determinism, distinct profile angles, AR purpose, 1–6 clamp); HTTP `factory-video-audio-policy-http.test.ts` topic route 201; DOM `order02-intake-ui` + `order02-content-plan-ui` (button reachable, fills brief, switches to brief mode) | HTTP 422 on unknown profile; DOM shows server refusal as alert | Real-browser click-through |
| Brief / topic only | HTTP: draft 201 `blocked`, exact `plannerGate` with `LOCAL_LLM_*` missing settings, actionable warning containing the retained phrase "No text is generated here." (`factory-video-audio-policy-http.test.ts`, `factory-api.test.ts`, `factory-visual-language-http.test.ts`) | Missing script gap `kind:'script'`; apply refused 422 | Local semantic planner output itself — no `llama-server`/model provisioned; the gate is the contract, not a passed engine |
| Script only | Preserved: `factory-sam-speech-local.test.ts` 2/2 ENGINE real sam-js Apply with isolated in-repo data root (`data/test-sam-local-*`, gitignored, cleaned); `factory-api.test.ts` green | Existing speech/asset refusals unchanged | Natural Arabic voice (Order 04 gate) |
| Audio only (independent transcript → correction → review) | Preserved contract: `factory-intake-http.test.ts` 24/24 incl. fixture runner, cancel, stale/failure, review; UI `TranscriptionPanel` DOM tests | Supplied script is never copied as a transcript (independence asserted in existing provenance `independentOfScript:true`) | Real runner on owner host; fixture runner only in sandbox |
| Pictures only (silent / optional narrative) | Preserved: `factory-silent-storyboard-apply.test.ts` (blank panels, duplicate/reorder/remove → applied clip order), manual descriptions UI copy states they are owner-written, never AI vision | Silent-with-words conflicts unchanged | Owner visual acceptance |
| Text/image/page storyboard, JSON/text | Preserved: storyboard cards DOM + HTTP suites; exact words/times/locks round-trip (`intake-panels`, `storyboard-cards`, `storyboard-conflict-*`) | Locked-row and 409 retention assertions unchanged | — |
| PDF page storyboard (new) | ENGINE+HTTP `factory-pdf-import-http.test.ts` 5/5: 2-page ordered panels, JPEG bound to page 1, source/licence on the asset, no draft created, then canonical draft 201; PURE parser `pdf-storyboard-parser.test.ts` 13/13 (Flate, TJ kerning, ToUnicode incl. Arabic س, WinAnsi, DCT JPEG, blank page ordering); DOM import populates cards and attaches the picture | 422 codes: `FACTORY_PDF_NOT_PDF/ENCRYPTED/NO_PAGES/TOO_LARGE/TOO_MANY_PAGES/UNSUPPORTED/MALFORMED`; missing source/licence applies nothing; unreadable index refused (`FACTORY_ASSET_INDEX_UNREADABLE`) with no overwrite; LZW/other filters named per page | Real-world owner PDFs (Word/Google Docs print path is the designed target but unproven on owner documents); ObjStm-only files are warned/refused, not parsed |
| Video footage — explicit audio policy | ENGINE+HTTP `factory-video-audio-policy-http.test.ts` 12/12: measured silent/voiced MP4s (bundled ffmpeg, independent ffprobe ground truth); `silent` and `original` apply with correct `keepAudio`; `add` keeps clip audio with supplied narration; legacy null policy stays muted; PURE `video-audio-policy.test.ts` 7/7; ENGINE mux `factory-kept-audio-mux.test.ts` 5/5 (kept-only, kept+narration mix, legacy strip, loud failure when raw render lacks the expected stream); DOM policy radios reachable | Precise refusals: silent clip under `original`, missing narration under `replace`/`add`, unknown enum 422, unmeasurable clip "could not be measured" (distinct from "no audio stream") | Remotion actually emitting the kept stream in a rendered MP4 needs Chromium (§5); mux behaviour and document wiring are proven without it |
| Mixed-source conflicts, 409 typed edits, failed upload, retry-only-failed, duplicate Apply | Preserved: conflict/authority HTTP suites, `PostCreateStoryboard` merge-after-409 DOM, idempotent Apply suites all green in the full run | Same refusal codes as the approved tree; no assertion weakened | — |

## 3. Parser and write-path hardening (reviewed against malformed input)

- Bounded inputs: 10 MB file, 60 pages, 4096 objects, 60 MB decoded; zlib `maxOutputLength` stops a single Flate bomb before allocation; nesting depth capped at 200 (precise `MALFORMED`, no stack overflow); cyclic/re-entrant page trees terminate via an all-node visited set; duplicate object numbers are refused instead of silent last-wins; unsupported filters are named per page and never silently dropped; ToUnicode destinations decoded as UTF-16BE (Arabic path covered by test).
- Asset writes: index write is now atomic (sibling temp + rename); a pre-existing unreadable/non-array index is refused rather than reset; pictures are written first and rolled back if the index write fails; JPEGs are magic-sniffed and dimension-parsed before binding. No silent extraction path exists: every unsupported feature lands in `unsupported`/`warnings` or a typed error.

## 4. Commands and exit codes (this session, branch working tree)

| Command | Result |
|---|---|
| `npm run build:core` | exit 0 |
| `npx tsc -p apps/api` | exit 0 |
| `npx tsc -p apps/web --noEmit` | exit 0 |
| `npm run build:web` | exit 0 (88 modules) |
| New/focused vitest group (17 files, listed in §2) | 198–220 passed, 0 failed across runs |
| Full non-render suite `BUILDTRACK_CI_LANE=non-render npx vitest run` | 2867 passed, 10 skipped, **5 failed — all pre-existing on base `eb0eac8`** (verified by stash-and-rerun): 2 export-guard 501s and 1 production-closure ffprobe gate need the render/engine host; the other 2 were this increment's warning-copy change and were fixed, then re-verified green |
| `tests/factory-sam-speech-local.test.ts` (script-only SAM, isolated data root) | 2/2 passed |

Skipped remains skipped (engine/render gates); no refusal test is counted as production success.

## 5. Exact unproven gates (do not infer completion)

1. **BROWSER (Chromium/Playwright absent in sandbox).** New UI flows have happy-dom evidence only; no real-browser screenshot/click evidence was produced. The owner-host browser acceptance used for earlier storyboard work is still required for topic starter, PDF import and policy radios.
2. **Remotion kept-audio emission.** `OffthreadVideo muted={clip.keepAudio !== true}` and the mux graph are implemented and the mux is proven with real ffmpeg fixtures, but an end-to-end render proving the browser step actually carries the clip audio stream into the raw MP4 needs Chromium. The mux fails loudly (verified) if that stream is ever absent, so this cannot degrade into silent success.
3. **Local semantic planner (`local_llm`).** No `llama-server`/pinned model is provisioned; brief-only drafts surface the exact missing settings. No model recommendation is treated as an owner provisioning decision.
4. **Real transcription runner, vision, conditioned stills, natural Arabic speech** remain the runtime gates recorded in STATUS.md; this increment neither opens nor closes them.
5. **Owner PDFs and owner footage** are private and not in Git; synthetic fixtures prove the contract only.

## 6. Owner-tree overlap analysis

Changed files intersect previously owner-touched areas as follows; each owner behaviour was preserved and regression-checked:

- `apps/api/src/routes/assets.ts` — adds an atomic index writer and strict read; the measured-upload route, current-byte hash checks, licence/source invalidation and sniffer rules are unchanged. All upload/mime/batch suites green.
- `apps/api/src/services/factory-service.ts` — additive policy/planner/topic wiring; blank silent storyboard handling, transcription gates, derived-review gate, locked rows, 409 rules and Apply idempotency are untouched in behaviour (full factory suite green).
- `packages/core/src/editor/document.ts` — adds optional fields and additive validation; legacy documents without the fields validate exactly as before (document suite 43/43).
- `apps/api/src/services/editor-render.ts` — mux branches only activate when a `keepAudio` clip exists; legacy silent/narration paths produce identical ffmpeg graphs (`factory-silent-export`, alignment and library-audio suites green).
- No change to vision timeouts/cancel, redirect refusal, manual-reference approval, 640×384/384×640 + `--vae-tiling`, or reference-hash rules. No new dependency, no lockfile/manifest edit, no owner data/output/WAV touched; all QA media are synthetic and written to isolated temp or gitignored data roots.

## 7. Files

New: `packages/core/src/factory/topic-starter.ts`, `packages/core/src/factory/video-audio-policy.ts`, `apps/api/src/services/pdf-storyboard.ts`, `apps/api/src/routes/factory-imports.ts`, `tests/topic-starter.test.ts`, `tests/video-audio-policy.test.ts`, `tests/pdf-storyboard-parser.test.ts`, `tests/factory-pdf-import-http.test.ts`, `tests/factory-video-audio-policy-http.test.ts`, `tests/factory-kept-audio-mux.test.ts`, `tests/web/order02-intake-ui.test.tsx`, `tests/web/order02-content-plan-ui.test.tsx`.
Modified (19): core contract/validation/draft-plan/editor-mapping/barrel, editor document/types, video Backgrounds/SceneRenderer, API server/factory route/factory-service/media/editor-render/assets, web factory-api/factory-model/IntakePanels/ContentPlan, tests/editor-document and tests/web/fixtures.

Next bounded task after owner review: Order 03 entry is not started by instruction; within Order 02 the only remaining evidence is real-browser acceptance and the Remotion end-to-end audio render on an engine host.
