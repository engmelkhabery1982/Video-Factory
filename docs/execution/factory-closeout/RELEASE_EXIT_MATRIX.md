# RELEASE EXIT MATRIX — G1–G12, 11 input routes, 7 visual families

**One finite document.** It states, for every open item, the required user-visible outcome, the existing route/component/service, the exact missing implementation, the required engine or resource, the verification method available, the expected output, the existing evidence, the missing acceptance evidence, and a class:

| Class | Meaning |
|---|---|
| **A** | Executable now with existing permitted resources (this tree + Node built-ins). |
| **B** | Blocked by a specific missing or unauthorized resource. |
| **C** | Requires actual owner-host execution or human review. |

Evidence labels used everywhere below, never mixed:

`IMPLEMENTED` (code + tests present) · `PURE` (no I/O, executed) · `SERVICE` (the real canonical service function executed, isolated storage) · `HTTP` (`app.inject` through real routes — **not run here: fastify absent**) · `DOM` (happy-dom, not a browser — **not run here: vitest absent**) · `ENGINE` (real engine produced output) · `BROWSER` (real Chromium) · `OWNER ACCEPTED`.

**This matrix is not acceptance.** Nothing here is owner-accepted, and no row is closed by a report.

---

## Source of this matrix

- Session branch `arena/88809335-video-factory`, fast-forwarded to the required reviewed base **`fa1e1cea79fb67a93081731f953869ba5b0a2353`** (it was a pure ancestor; 209 commits preserved, nothing reset or force-checked).
- Environment: Node 22.22.3, **no `node_modules`, no `ffmpeg`/`ffprobe`, no Chromium, no GPU runtime**. Every absence is recorded, not worked around by installing.
- The one implementation repair in this closeout is `apps/api/src/services/factory-service.ts` (technique→media-need gate; truthful corrupt-draft failure). See §6.

---

## A. Unified gap matrix (G1–G12)

| Gap | Required user outcome | Existing route / component / service | Exact missing implementation | Required engine / resource | Verification method available | Existing evidence | Missing acceptance evidence | Class |
|---|---|---|---|---|---|---|---|---|
| **G1** | Optional/mixed inputs with source priority, locks, revisions and metadata | `POST/PATCH /api/factory/drafts[/:id/intake]`, `topic-suggestions`, `planFactoryDraft` (`@buildtrack/core`) | **None found.** Priority/lock/revision/conflict logic present and exercised | none | `SERVICE` (executed here) + `PURE` | `SERVICE`: conflict surfaced with both sources + authority (`qualify-input-routes` row 11); topic starter; planner gate. `HTTP`/`DOM` suites exist, not run (fastify/vitest absent) | Real-browser acceptance of intake panels | **A** (code) / **C** (browser) |
| **G2** | Audio-only independent transcription → review → alignment | `POST/GET/PATCH /api/factory/transcriptions`, `factory-transcription.ts` | **None in code.** Runner contract (named-flag argv, hashed runner identity, review-at-revision) complete | Real ASR runner (`VF_TRANSCRIBE_COMMAND` + `VF_ALIGN_CHECKPOINT`/`TOKENIZER`) | `SERVICE` refusal path executed (capability `available:false`, precise reason, no invented transcript); argv contract asserted | `SERVICE`: refusal + argv/path-mapping/capability (`qualify-input-routes` row 4) | Real transcription of owned audio, correction review, mapped alignment, listening check | **B** — see decision package D7 |
| **G3** | Local picture understanding, reference conditioning, consistency | `local-image.ts`, `local-vision.ts`, `/visual-review`, `/bind-image`, `conditioningRequestFor` | **None in code** (adapter + UI + candidate staleness present) | Local SD runtime + vision model | Adapter contract only; cannot execute inference here | `SERVICE`: reference role kept out of shots (`qualify-input-routes` row 6); readiness reports `setup_required` | Real vision output; real conditioned still compared to its reference | **B** — D1 |
| **G4** | Text/JSON/image/page storyboard ingestion + structural editing | `POST /api/factory/drafts`, `PATCH intake`, `/imports/storyboard-pdf`, built-in PDF parser | **None found.** Text/JSON/PDF parse, ids/locks/times, conflict retention present | none (built-in parser) | `SERVICE` + `PURE` (parser executed on a real synthetic PDF) | `SERVICE`: ids/wording/times/locks preserved (row 7); PDF parser returned 1 page/1 panel with extracted text (row 8) | Multipart HTTP import route (`HTTP`), owner-document PDFs, browser flow | **A** (parser) / **B** (HTTP needs fastify) / **C** (owner docs) |
| **G5** | Diverse editable families: motion, 2D, illustrated, screen, documentary, kinetic, mixed | `buildTreatments` + `VISUAL_TECHNIQUES`, graphic builders, `GraphicEditors.tsx` | **None found in code.** All 7 techniques registered; register/storage/preflight verified for each | Remotion + Chromium for pixels | `SERVICE` for structure/values; render not executable here | `SERVICE`: 7 families + mixed draft, exact numeric value `12.3456` preserved, Arabic RTL preserved, distinct treatment sets per profile (`qualify-visual-families`) | Rendered frames per family; direction/quality review | **A** (structure) / **B** (render) / **C** (quality) |
| **G6** | Generated moving video, 3D, talking characters | **None.** No accepted adapter. `screen_recording`/`footage_clip` are *supplied*, not generated | Entire capability is absent by design | See D3 (video), D4 (3D), D5 (talking/Arabic) | Cannot be faked; verified as genuinely absent | `SERVICE`: both supplied-media families refuse rather than substitute a still (`qualify-visual-families` 4, 5) | One real generated clip / 3D render / talking character, owner-reviewed | **B** — D3, D4, D5 |
| **G7** | Image quality, composition, reference fidelity, masked/regional correction | `/masked-corrections/*`, `masked-correction-sd-cli.ts`, `MaskedCorrectionPanel.tsx` | **None in code.** Mask validation, durable job, provenance, Apply/reopen, cancellation, scratch ownership all present | Authorized inpainting artifact (D2) | `SERVICE` truthfulness + `PURE` mask contract | `PURE` 27 mask/fingerprint + 9 sd-cli protocol + 6 UI-pure (executed here). `SERVICE`: locked scene refuses a correction target; readiness reports no runner | One real corrected image: original preserved, distinct hashes, visual review, Apply/reopen | **B** — D2 |
| **G8** | Natural Arabic / local speech independence | `voice-audio` routes, Kokoro, Chatterbox adapter, SAM HTTP | **None in code**; natural Arabic engine absent | Arabic TTS (D5) | Cannot be produced here | `SERVICE`: silent drafts create no speakers and no fabricated words (row 10) | Real Arabic clip, listening-reviewed | **B** — D5 |
| **G9** | New audio sync, translated text, cue timing | `external-narration.ts`, `external-timing-review.ts`, export identity gate | **None found.** Approval/revision identity + export gate wired | Measured duration (ffprobe) + owner recording | `SERVICE`: export identity computed and change-detected | `SERVICE`: `identityOf` / `sameExportIdentity` computed on a real applied project; `reviewIdentityChanged` isolates review-relevant changes | Real owner recording + listening/timing approval | **B** (ffprobe) / **C** (listening) |
| **G10** | Complete in-app production including consented capture | `CapturePanel.tsx`, `lib/capture.ts`, upload route | **None in code.** State machine, retry, discard, URL cleanup, refusal to replace a completed capture all present | Real `getDisplayMedia`/`MediaRecorder` on a browser (owner-host) | `PURE` state machine executed here | `PURE` 31 capture transitions (executed). Component/DOM and native capture **not run** (vitest + browser absent) | Real consented capture of an owned surface, playable review, upload confirm, retry, discard, cleanup | **B** (browser) / **C** (consent is the owner's) |
| **G11** | Readiness, budgets, cancellation, restart/cache, resource limits | production/editor/transcription/turn stores, bounded masked jobs, `factory-data-recovery.mjs` | **One real defect found and fixed** (§6.2: corrupt draft surfaced as a bare crash) | none | `SERVICE` + `PURE` | `SERVICE` (executed here): concurrent applies converge on one project; stale revision refused with no side effect; corrupt sidecar refused truthfully with the damaged file preserved; a **separate process** reads the same state (`qualify-recovery`) | Live process-kill during a render; real queue pressure | **A** (most) / **B** (render cancellation) |
| **G12** | Final matrix + accepted rendered files + recoverable release | This matrix, decision package, release guide, recovery tool | **None in code.** Offline backup/verify/restore complete | none for recovery | `SERVICE`/`PURE` executed | Offline backup → verify → restore of **real factory data**: 9 files, 9 byte-identical; tampered backup detected and restore wrote nothing; symlinked root refused (`qualify-recovery`) | Rendered sample per family; owner release decision | **A** (recovery) / **C** (release) |

---

## B. Input acceptance matrix — 11 rows

All 11 were exercised through the real service in `scripts/qualify-input-routes.mjs` (16 steps, 16 passed, isolated storage).

| # | Row | Outcome verified | Status | Remaining | Class |
|---|---|---|---|---|---|
| 1 | No material | 3 deterministic topic suggestions; a brief alone names the exact planner gate and invents nothing | IMPLEMENTED | — | **A** |
| 2 | Topic only | 3 treatments with 3 distinct structures | IMPLEMENTED | semantic planner is a separate engine (D6) | **A** |
| 3 | Script only | Words preserved exactly, Arabic intact after reopen | IMPLEMENTED | — | **A** |
| 4 | Audio only | No runner → precise refusal, no invented transcript; configured-runner argv contract asserted | PARTIAL | real ASR (D7) | **B** |
| 5 | Pictures only | Ordered silent panels keep supplied order | IMPLEMENTED | — | **A** |
| 6 | Reference + text | Reference role honoured, never an automatic shot fallback | PARTIAL | pixel conditioning (D1) | **B** |
| 7 | Text storyboard | ids, wording, times, locks preserved exactly | IMPLEMENTED | — | **A** |
| 8 | Image/page storyboard | Built-in parser read a real PDF: 1 page, 1 panel, text extracted | PARTIAL | multipart HTTP route; owner documents | **B**/**C** |
| 9 | Video with audio | Unmeasurable clip is never claimed silent; policy stays explicit | BLOCKED | ffprobe/ffmpeg absent | **B** |
| 10 | Video without audio | 0 speakers invented; labelled visual-duration proposal | IMPLEMENTED | — | **A** |
| 11 | Mixed/conflicting | Conflict reported with both sources and the resolved authority | IMPLEMENTED | — | **A** |

---

## C. Visual families — 7 rows

`scripts/qualify-visual-families.mjs` (9 steps, 9 passed). Storage/preflight are proven; **pixels are not**.

| Family | Technique | Verified here | Status | Missing | Class |
|---|---|---|---|---|---|
| Motion-graphics explainer | `process_path` | Nodes + marker + progress action stored exactly; preflight clean | IMPLEMENTED (structure) | rendered frames, direction quality | **A**/**B**/**C** |
| Procedural 2D actors | `actor_action` | Figure + timed arm action stored; validator accepted | IMPLEMENTED (structure) | render | **A**/**B** |
| Illustrated narrative | `still_image` | Empty shot is refused; supplied image path wired | PARTIAL | local generation (D1) | **B** |
| Real screen tutorial | `screen_recording` | A still is **refused** as a recording (§6.1) | BLOCKED | real capture (G10) or supplied recording | **B**/**C** |
| Footage documentary | `footage_clip` | Refused with a footage-specific reason | BLOCKED | supplied video + ffprobe | **B** |
| Kinetic typography | `kinetic_text` | Arabic words + RTL direction intact after reopen | IMPLEMENTED (structure) | render | **A**/**B** |
| Mixed scenes | `numeric_comparison` + `still_image` | Two families in one draft; exact value `12.3456` preserved | IMPLEMENTED (structure) | render | **A**/**B** |
| Generated video / 3D / talking character | — | Genuinely absent; not substituted | BLOCKED | D3 / D4 / D5 | **B** |

---

## D. Consolidated resource decision package

Four distinct capabilities are blocked by a missing resource. **This package is not installation authorization.** Downloading, installing or spending requires a separate scoped owner decision. Fields marked *unknown* are exactly that.

### D1 — Local vision + reference conditioning (G3, part of G7)
- **Why necessary:** without it there is no local image understanding and no pixel-conditioned still; the reference row stays a manual approval step only.
- **Source / version:** Stable Diffusion 1.5, `runwayml/stable-diffusion-v1-5` (CreativeML Open RAIL-M). Exact file/revision must be recorded from the owner's existing copy.
- **Size / checksum:** *unknown here* — not downloaded. Must be recorded from the owner's file before use.
- **Hardware:** GPU strongly recommended (≥6 GB VRAM at fp16 512×512); CPU runs but slowly. Owner: ~16 GB RAM, AMD Radeon integrated graphics, no proven dedicated VRAM.
- **Cost:** 0 licence fee.
- **Smallest acceptance run:** one conditioned still from one owned reference, visually compared with the reference.
- **Existing equivalent that satisfies it:** none. The manual-reference approval path is intentionally not image generation.

### D2 — Masked / regional correction (G7)
- **Why necessary:** the only path from "this region is wrong" to a corrected still that preserves the original.
- **Source / version:** `runwayml/stable-diffusion-inpainting`, `sd-v1-5-inpainting.ckpt`, CreativeML Open RAIL-M; adapter targets the pinned `stable-diffusion.cpp` CLI commit `1d0a58a35050d285b1d6fb1bc68a92924d35825e`.
- **Checksum / size (from upstream metadata, file not downloaded):** SHA-256 `c6bbc15e3224e6973459ba78de4998b80b50112b0ae5b5c67113d56b4e366b19`, 4,265,437,280 bytes. `.safetensors` variant SHA-256 `3a754af8bc8f427ad3c5eabe134ecd6edf02eb7d1ff9d71a5294ba7f19f0bb90`, 4,265,203,900 bytes.
- **Hardware:** as D1.
- **Cost:** 0 licence fee.
- **Smallest acceptance run:** one masked correction on an owned synthetic still → original preserved → measured result/provenance → visual review → Apply → reopen.
- **Existing equivalent:** none. The fake CLI and mock runner are fixtures and are labelled as such; they are not output.

### D3 — Generated moving video (G6)
- **Why necessary:** every other family animates supplied or procedural material; only a generative model produces new motion.
- **Preferred source:** `Wan-AI/Wan2.2-TI2V-5B`, Apache-2.0, BF16 weights ≈10.5 GB, full repo ≈34.2 GB.
- **Checksum:** *unknown* — not published on the model card; must be recorded from the owner's download.
- **Hardware:** ≥24 GB VRAM minimum with offloading; 80 GB+ for full speed. The owner's integrated graphics are **not** verified sufficient.
- **Cost:** 0 licence fee; hardware is the real cost.
- **Smallest acceptance run:** one short clip (a few seconds) inspected for motion and identity.
- **Alternatives:** SVD-XT (image-to-video only, ≥24 GB VRAM); AnimateDiff-Lightning (≥8 GB, animates existing stills, not standalone text-to-video).
- **Existing equivalent:** none. The separate Blender 4-second proof is **not** factory integration.

### D4 — 3D (G6)
- **Why necessary:** real 3D is a required family distinct from procedural 2D.
- **Preferred source:** Blender 4.x LTS + Cycles (GPL v2+ / Apache-2.0), headless `--background`.
- **Checksum / size:** *unknown* — pin the exact build from the owner's installer.
- **Hardware:** CPU-feasible for simple scenes; GPU recommended. Not verified on the owner's integrated graphics for production quality.
- **Cost:** 0.
- **Smallest acceptance run:** one headless render of one simple owned scene, inspected.
- **Existing equivalent:** none. The Blender proof's existing permission covers only that four-second proof and does not extend to factory integration or a full episode.

### D5 — Talking characters / natural Arabic speech (G6 talking-character, G8)
- **Why necessary:** SAM is robotic English; Kokoro is English-oriented; neither satisfies natural Arabic independence.
- **Preferred source:** `silma-ai/silma-tts` v1, Apache-2.0, 150M params, bilingual AR/EN, MSA with diacritization.
- **Checksum / size:** *unknown* — must be recorded from the owner's download.
- **Hardware:** GPU recommended; RTF ≈0.12 is the model card's claim on an RTX 4090 (**not independently verified**). CPU possible but slow.
- **Cost:** 0 licence fee.
- **Smallest acceptance run:** one Arabic clip, listening-reviewed by the owner.
- **Alternatives:** SpeechT5 Arabic fine-tune (small, MIT code); XTTS-v2 (MPL-2.0, but upstream Coqui is defunct).
- **Existing equivalent:** none. SAM English samples are not this proof.

### D6 — Local semantic planner (G1/G4/G5)
- **Why necessary:** without it, a brief alone cannot become scenes; only `local_rules` structure exists.
- **Source:** `Qwen/Qwen2.5-1.5B-Instruct-GGUF` revision `91cad51170dc346986eccefdc2dd33a9da36ead9`, file `qwen2.5-1.5b-instruct-q4_k_m.gguf`, Apache-2.0; runtime `ggml-org/llama.cpp` release `b11429`.
- **Checksum / size (pinned in code):** SHA-256 `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e`, 1,117,320,736 bytes.
- **Hardware:** CPU-feasible; ~16 GB RAM sufficient; latency unverified.
- **Cost:** 0.
- **Smallest acceptance run:** one brief → validated 3-treatment draft through the loopback server.
- **Existing equivalent:** none for semantics; `local_rules` is deterministic structure, not meaning.

### D7 — Local transcription (G2)
- **Why necessary:** audio-only input has no independent transcript without it.
- **Preferred source:** `ggml-org/whisper.cpp` (MIT) + `ggml-medium.bin` or `ggml-large-v3.bin`.
- **Checksum / size:** *unknown* — pin from the owner's download (≈1.5 GB / ≈3 GB).
- **Hardware:** CPU-feasible; ~16 GB RAM sufficient.
- **Cost:** 0.
- **Smallest acceptance run:** one owned audio → transcript → correction review → mapped alignment.
- **Existing equivalent:** none. The fixture runner proves the contract, not transcription.

**Not in this package, deliberately:** the religious/BuildTrack separation, episode production and any scheduling/BIM extension are out of scope for this order.

---

## E. What is actually finished versus open

**Finished in this increment (code + executed service evidence):** the canonical production journey end-to-end through Apply/edit/reopen (14 steps), all 11 input routes (16 steps), all 7 visual families' structure (9 steps), recovery/fault/restart (9 steps), 87 PURE cases, one real defect repaired with a regression test, and one executable host qualification entry point.

**Open, and not to be described as complete:** every rendered pixel of every family; real vision/conditioning; real inpainting; real ASR; natural Arabic; generated video; 3D; talking characters; native consented capture; real-browser acceptance of the whole UI; and the owner's visual/listening/release decisions.

**The factory is not closed and not code-complete.** This increment delivers a verified operating core plus an honest, finite list of what remains.

---

## F. CLOSEOUT07 delta (base `4a3673ef`)

Two defects were mandated by this order and both had already been reproduced on the owner host. The third section corrects a stale row.

### F.1 Defect 1 — Windows export path failure (repaired)

- **Reproduction (owner host, reused; not re-run here):** the editor export rendered `raw-frames.mp4`, then the packaged FFmpeg refused the 262-character path although the file existed. Copying disposable QA data to a shorter root made the *same revision* export successfully.
- **Root cause, exact:** `editor-render.ts` built `path.join(input.workDir, 'raw-frames.mp4')`, and `editor-preview.ts` had passed `workDir = <data>/projects/<id>/editor/export-work/<jobId>` — i.e. the raw render and every audio copy lived under the full canonical data path. `muxPreviewVideo` and `probe` handed those paths straight to `ffmpeg`/`ffprobe`, and nothing validated length.
- **Repair:** a new module `apps/api/src/services/editor-render-paths.ts` (path budget, short-root choice, owned-scratch open/cleanup, binary-reachability guard) plus validation at every binary boundary in `editor-render.ts`, an owned per-job scratch directory used by `runPreview` (removed in `finally`, marker-gated), and a pre-`202` readiness refusal in both editor routes.
- **Preserved unchanged:** project ids, draft/editor revisions, frozen revisions, `outputFile` locations, `mediaUrl` strings, silence/audio policy, portrait/landscape dimensions and warning text.
- **Evidence:** `scripts/qualify-render-paths.mjs` 16/16 and `tests/editor-render-paths.test.ts` (source-level; not run here — no vitest). **These are path-strategy and ownership proofs, not Windows compatibility proofs.**
- **Still open:** the finite real-FFmpeg check (`scripts/qualify-ffmpeg-longpath.mjs`) is **NOT RUN** — no `ffmpeg`/`ffprobe` in this environment. It exits `SKIPPED`, never `PASSED`, and is wired into `scripts/host-qualify.mjs`.

### F.2 Defect 2 — real completion timestamps (repaired)

- **Root cause, exact:** `runPreview()` assigned `finishedAt: new Date().toISOString()` *before* `await renderEditorPreview(...)`, so both `ready` and `failed` records carried a time within milliseconds of `createdAt`.
- **Repair:** `createdAt` is untouched and `finishedAt` is stamped once, only in the `ready` and `failed` branches after the render settles. No duration field was added, and nothing is relabelled as measured performance: `createdAt` is enqueue time, not start time.
- **Evidence:** `qualify-render-paths.mjs` drives the REAL job lifecycle (`createExportJob` → `enqueuePreview` → persisted record → `loadExportJob`) with a **controlled delayed renderer stand-in** and asserts the completion offset is at least the injected delay, on both the success and failure paths. Interruption semantics (`loadJob` reporting a running record with no worker as failed) are re-asserted unchanged.
- **Honest limit:** the stand-in proves *when* the timestamp is assigned. It says nothing about real render duration.

### F.3 Stale row corrected

Input row **8** (image/page storyboard) listed "multipart HTTP route" as missing. It exists and is registered: `apps/api/src/routes/factory-imports.ts:42` → `POST /api/factory/imports/storyboard-pdf`, wired at `apps/api/src/server.ts:225`, with measured `%PDF-` magic, `PDF_MAX_BYTES`, mandatory source/licence fields, and asset files written only after the whole multipart message is processed. What actually remains for row 8 is `HTTP` execution (needs fastify) and owner documents — class **B**/**C**, not **A**.

### F.4 Class-A sweep result

Every row labelled **A** in §A and §B reads "IMPLEMENTED" or "None found in code". No further independently executable implementation gap exists in the existing services, editor or routes for G1–G12, the 11 input rows or the 7 visual families. Everything still open is (b) implemented-but-awaiting-real-runtime/output, or (c) human consent/listening/quality/release — with the single exception of the D6 planner, which belongs to the owner-host workstream and was not touched (no download, no model run, no prompt/schema/configuration change, no concurrent edit).

### F.5 New evidence in this delta

| Check | Result | Class |
|---|---|---|
| `scripts/qualify-render-paths.mjs` | 16 passed, 0 failed, 0 skipped | SERVICE/PURE |
| `scripts/qualify-export-contracts.mjs` | 7 passed, 0 failed | SERVICE/PURE |
| `tests/editor-render-paths.test.ts` | source only — **NOT RUN** (no vitest) | — |
| `scripts/qualify-ffmpeg-longpath.mjs` | **NOT RUN** — real binaries absent, exits `SKIPPED` | — |
| `qualify:all` (4 canonical scripts, unchanged paths) | 14/14, 16/16, 9/9, 9/9 — reused, not affected by this delta | SERVICE |

Owner9November: CLOSEOUT07 path/settlement bounded host qualification passed after extra budget/cleanup repairs, including actual original-shape deep-root12s360frame export. See OWNER_FACTORY_CLOSEOUT07_REVIEW_2026-11-09.md. This does not close the D6 semantic or other real-engine/output/quality rows; approved/F not promoted.

D6 update9November: resources now present/SHA-verified, native structured planning and persisted draft/reopen proven after decoder-escaping/tuple fixes. Bounded educational content refinement also ran natively with preserved words/IDs. Semantic direction/completeness remains OPEN (see OWNER_FACTORY_D6_SCHEMA_REPAIR_2026-11-09.md). D6 is no longer blocked by missing installation; no new engine or whole-factory acceptance is implied.

## D6 completeness delta —9November14:53UTC
See OWNER_FACTORY_D6_COMPLETENESS_2026-11-09.md: observed cut-off composition endings now rejected, grammar has finishing room without host clipping;11/11 affected labelled-double cases PASS/APItypes0. Nine actual small native decomposition diagnostics plus six changed production composition calls reused saved native words/bindings; no full plan rerun. Production six-field completeness/unchanged validator passed, but semantic review FAILED: inspection falsely fills trench with debris and method distinctions collapse. Diagnostic result not Applied/persisted as accepted/rendered/promoted. Native runtimes stopped. D6 meaning and whole release remain OPEN. Next finite resource/architecture decision from saved counterexamples, no unchanged retries or unapproved model switch/download. Approved/F unchanged.
