# Closeout increment: storyboard structure, reference media, integrated acceptance

Branch: `arena/890ccb82-video-factory`. Base for `697d78c`: `c2bf698325eb3fd699be2c0d67ce89c28fd25fbd`. This closeout increment starts from `697d78c`.
Scope: fixture, HTTP and DOM evidence only. None of this is browser, owner-host or live-provider evidence.

## What changed

| Area | Change | Evidence |
| --- | --- | --- |
| A. Storyboard structure | `checkStoryboardEdit` now allows add, duplicate, remove and reorder on silent, untimed drafts. Refusals: `FACTORY_STORYBOARD_EMPTY` (422, last row), `FACTORY_SCENE_LOCKED` (423, names scene IDs, includes indirect shifts), `FACTORY_TIMED_STRUCTURE` (422, timed rows or supplied audio), `FACTORY_SUPPLIED_ORDER_CHANGED` (422, supplied narration order or added words). | `tests/factory-storyboard-edit-http.test.ts` 14/14 |
| A. Card UI | Per-card Up, Down, Duplicate and Remove, plus Add panel. Locked cards get disabled controls. The server refusal remains the authority. | `tests/web/storyboard-cards.test.tsx` 15/15 |
| A. Applied projects | An applied project's stored editor state is byte-identical after draft structure edits. Duplicate Apply for the same revision returns the same project with status 200. | `factory-storyboard-edit-http` (applied snapshot test) |
| B. Image MIME | Image uploads take their type from the measured bytes (PNG, JPEG, WebP, GIF). A declared image that is not one of these is refused, which includes SVG markup. | `tests/asset-image-mime-http.test.ts` 5/5 |
| B. Storyboard files | Plain-text import (one panel per line, optional `id:` prefix), a file input for `.json` and `.txt` files (256 KB cap), and Export text. A plain-text import matches by ID and keeps timing, speaker and lock. A locked card missing from the text is refused. | `tests/web/factory-model.test.ts`, `tests/web/storyboard-cards.test.tsx` |
| B. PDF | Unavailable. No PDF parser is installed in `node_modules`. Other formats are not blocked. | audit only |

## Changed test expectations (deliberate, not weakened)

- Silent-draft reorder, add and remove used to be refused. The new requirement allows them, so the old test was replaced with the new rules.
- `parseStoryboardText('not json')` used to be refused. Plain text is now a valid import. Malformed JSON, which starts with `{`, is still refused.
- The lock test's indirect-shift case first asserted the wrong thing (the locked row's index was unchanged). It now removes the row before the lock, which moves the locked row.

## Closeout increment on top of `697d78c`

| Area | Change | Evidence (fixture, HTTP or DOM; not browser) |
| --- | --- | --- |
| B. Ordered multi-image ingest | `apps/web/src/lib/image-batch.ts` and `ImageBatchUpload.tsx`. Pictures are uploaded one at a time, in the shown order, through the existing `POST /api/assets` route. Each file has a status (queued, uploading, done, failed). A failed file is retried alone and is not re-sent when others succeed. The summary never says complete while a file is failed or queued. Cards are made one per final or storyboard picture in batch order. A reference (style or character) attaches with its role and never becomes a card. A second "add as cards" adds nothing. | `tests/web/image-batch.test.ts` 6/6; `tests/web/image-batch-ui.test.tsx` 2/2; `tests/asset-image-batch-http.test.ts` 2/2 (measured route; a refused file adds nothing; a retry stores once) |
| B. Manual picture descriptions | `visualNotes` can be typed per picture, before and after Create. The text is labelled manual and is never generated. The server already validated `visualNotes`; the web client now sends it only for attached pictures. | `tests/web/picture-notes.test.tsx` 2/2; `tests/factory-input-matrix-integrated.test.ts` manual-description row (server stores it; unattached picture refused 422) |
| A/B. Stale 409 keeps typed edits | `PostCreateStoryboard` keeps typed words, timings and pictures on a stale 409, offers an explicit "Reload draft", and merges the newer stored storyboard with the typed edits (`mergeStoryboardEdits`). The merge note names conflicts. The stored bytes do not change on a refused save. | `tests/web/storyboard-conflict-http.test.tsx` 3/3 (real client, real routes, real stale 409 from another writer; reload, merge, save, stored bytes, reopen; locked row refused naming its scene ID; start after end refused in the page with no request and by the route with no write) |
| B. Reference identity guard | `referenceIdentityOf` and `candidateIdentityOf`. Style and character references, with their role and stored-bytes SHA-256, enter the candidate fingerprint only when attached. Replacing a reference or changing its role makes that draft's candidate stale. A final shot is not a reference. | `tests/factory-reference-candidates.test.ts` 5/5 |
| D/E. Integrated input matrix | `tests/factory-input-matrix-integrated.test.ts`, real routes and real uploaded fixtures, no provider. Rows: topic only; script only (BLOCKED by the speech engine, see below); script and storyboard that differ with no authority (refused, nothing written); silent pictures; text storyboard; silent video of 6 s; silent video of 2 s (refused by name because the scene needs 4 s); mixed references; structural edits after Create; manual description; Apply snapshot. | 11 passed, 1 skipped (the zero-audio export render, which is BLOCKED and never reported as passed) |
| Labels | Visible control labels added: "Reference-conditioned generation is unavailable" next to the existing vision note. | `tests/web/picture-notes.test.tsx` |

Test fixture notes (corrections, not weakened assertions):
- The silent-video fixture was 2 s and refused by the server with `FACTORY_ASSET_INVALID`, "Scene p01 needs 4s of video but silent-… is shorter." That refusal is correct. The fixture is now 6 s, and a separate 2 s clip is kept as a refusal row.
- The stale-revision case is checked before the lock case by the server. A test that expects a lock refusal must reload after the conflict, and the new test does this.

## Not done or blocked (kept open)

- **C1. Automatic local image understanding: BLOCKED.** No vision runtime is configured in the repo or the app. Automatic description is labelled unavailable. Manual descriptions are the default. See the decision sheet below.
- **C2. Reference-conditioned generation: BLOCKED.** No conditioning runtime is configured. Reusing or attaching a picture is not conditioned generation. The app says so. The engine-independent guards above are implemented.
- **Pair A (religious still life) and Pair B (educational truck): UNPROVEN.** They need a real runtime and owner review. Fixture images are not acceptance.
- **Browser acceptance: BLOCKED in this sandbox.** No runnable browser is installed, and none was requested again. All evidence above is HTTP, DOM or fixture evidence. Owner checklist below.
- **Speech engine row: BLOCKED.** The "script only, no narration choice" row reaches Apply and stops with `FACTORY_SPEECH_FAILED` (503), because the local speech engine is not available to this fixture. It is not a pass. No provider call was made.
- **Audio-only and transcript rows:** covered by the existing fixture suites (`tests/factory-intake-http.test.ts`, `tests/factory-transcription-runner.test.ts`). They are not re-proven here, and no independent transcript is claimed.
- **PDF storyboard import:** unavailable. No PDF parser is installed.

## Decision sheet: local vision and reference conditioning

Sources were read on 2026-10-16. Nothing here is installed, downloaded or configured. Sizes are from the Hugging Face API tree metadata. The LFS SHA-256 values are the publisher's declared hashes and are NOT verified locally. The stored files were never downloaded.

Two different capabilities are covered. Keep them apart:

1. **Captioning or description (vision understanding).** The model reads a picture and returns text. The text planner still does not see pixels.
2. **Reference-conditioned generation.** A reference picture guides a new image, for example an IP-Adapter. This is different from captioning.

### Candidate A: llama.cpp multimodal (captioning)

- **Capability and protocol:** `libmtmd` accepts image, audio and video input in `llama-server` (OpenAI-compatible `/chat/completions`), `llama-cli` and `llama-mtmd-cli`. It needs a text GGUF and a multimodal projector (`--mmproj`). Source: https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md (last commit Jun 18, 2026).
- **Licence:** llama.cpp is MIT (https://github.com/ggml-org/llama.cpp/blob/master/LICENSE, copyright 2023-2026). The model licences are separate. Qwen2.5-VL-3B-Instruct is `qwen-research` (HF API metadata, licence link to its LICENSE file, which must be read before any use). Qwen2.5-VL-7B-Instruct is `apache-2.0` (HF API metadata). GGUF repository licences were not read.
- **Files and sizes (ggml-org HF API):**
  - Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf 1,929,901,056 B, plus mmproj-Qwen2.5-VL-3B-Instruct-Q8_0.gguf 844,757,728 B. Total 2,774,658,784 B (about 2.77 GB).
  - Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf 4,683,072,032 B, plus mmproj-Qwen2.5-VL-7B-Instruct-Q8_0.gguf 853,119,712 B. Total 5,536,191,744 B (about 5.54 GB).
- **Windows and WSL:** the llama.cpp doc does not state Windows or WSL support. Not verified in this audit.
- **Resource needs:** the sources do not state memory or speed. Not invented here. Owner evidence is required.

### Candidate B: stable-diffusion.cpp with IP-Adapter (reference-conditioned generation)

- **Capability and protocol:** IP-Adapter for SD 1.5 and SDXL, including Plus variants. The reference image sets appearance, with `--ip-adapter`, `--ip-adapter-image` and `--ip-adapter-strength` (default 1.0; 0.6 to 0.8 is the suggested start). It needs `--clip_vision` with a CLIP-Vision ViT-H/14 encoder. ControlNet is supported for SD 1.5 only. Sources: https://github.com/leejet/stable-diffusion.cpp (feature list; README dated Oct 2026) and https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/ip_adapter.md (last commit Oct 13, 2026).
- **Licence:** stable-diffusion.cpp is MIT (https://github.com/leejet/stable-diffusion.cpp/blob/master/LICENSE, copyright 2023). h94/IP-Adapter is `apache-2.0` (HF API metadata). The SD 1.5 base licence was not read.
- **Platforms:** the README lists Windows, Linux and macOS, with CPU, CUDA, Vulkan, Metal, OpenCL and SYCL backends. Windows with a specific backend on the owner machine is not verified.
- **Files and sizes (h94/IP-Adapter and stable-diffusion-v1-5, HF API):**
  - CLIP-Vision image encoder `models/image_encoder/model.safetensors` 2,528,373,448 B. Publisher LFS SHA-256 `6ca9667da1ca9e0b0f75e46bb030f7e011f44f86cbfb8d5a36590fcd7507b030`.
  - `models/ip-adapter_sd15.safetensors` 44,642,768 B. Publisher LFS SHA-256 `289b45f16d043d0bf542e45831f971dcdaabe18b656f11e86d9dfba7e9ee3369`.
  - `models/ip-adapter-plus_sd15.safetensors` 98,183,288 B (Plus variant).
  - SDXL adapters exist under `sdxl_models/` (sizes not read).
  - SD 1.5 base `v1-5-pruned-emaonly.safetensors` 4,265,146,304 B. Publisher LFS SHA-256 `6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa`.
  - Classic SD 1.5 path total: 6,838,162,520 B (about 6.84 GB), if the owner has no SD 1.5 base already. The owner's installed SD base was not identified in this audit.
- **Resource needs:** not stated by the sources. Owner evidence is required. No speed or quality is claimed.

### Excluded

- Cloud image generation and Google image generation are excluded by the project rules.
- Captioning with Candidate A does not give reference-conditioned generation. Candidate B does not give captioning.

### Owner-hardware evidence still missing

1. GPU model, VRAM, driver version, and whether WSL2 GPU passthrough is available.
2. CPU and RAM on the owner machine.
3. Which runtime build the owner will use, and whether the installed planner runtime can host the projector.
4. One measured run per candidate on an owner-supplied picture, with time and peak memory measured on the owner host. Output reviewed by the owner before any use.
5. Owner review of description quality. No quality claim is made without it.

### Recommendation

Keep manual descriptions as the default. Do not enable either candidate until items 1 to 4 are supplied. Labels stay "blocked" in the app until a real runtime exists.

## Owner browser checklist (not run here)

On the owner host, with a browser the owner installs:
1. Open the content plan. Add three pictures in one batch. Confirm the order and the per-file result. Remove one, retry it, and confirm no duplicate.
2. Choose roles, type a description, then Create. Confirm the description is labelled manual.
3. Open the post-create storyboard in two tabs. Save in one tab, then edit and save in the other. Confirm the conflict note, the typed words, the Reload draft merge, and one saved storyboard.
4. Lock a row in one tab and try to save an edit to it in the other. Confirm the refusal names the scene ID.

## Owner command (unchanged)

The transcription owner check is unchanged from `c2bf698`. The owner runs it on the owner host; it is not run here.
