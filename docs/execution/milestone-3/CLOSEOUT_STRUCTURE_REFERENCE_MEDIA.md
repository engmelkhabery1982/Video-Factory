# Closeout increment: storyboard structure, reference media, integrated acceptance

Branch: `arena/890ccb82-video-factory`. Base: `c2bf698325eb3fd699be2c0d67ce89c28fd25fbd`.
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

## Not done in this increment (kept open)

- **C. Local image understanding.** Not implemented. No vision-language runtime is configured in the repo or the app. Automatic description of pictures is therefore unavailable, and the app does not claim it. Manual per-picture notes (`visualNotes`) and roles (`visualRoles`) are stored and are labelled manual.
- **C. Reference-conditioned generation.** Not implemented. Reusing an image is not claimed to be conditioned generation.
- **B. Multi-image ordered upload into cards in one action.** Not implemented. Single-image upload exists.
- **Stale 409 keeps typed edits in the UI.** The server write is refused (tested). The UI retention of typed text is not separately tested.
- **D and E.** No new end-to-end matrix this increment. Input rows from earlier increments are not re-proven here.

## Decision sheet: local vision runtime (needed for C1)

Only if a local image-understanding path is wanted. Nothing here is installed or downloaded.

1. **Exact missing capability:** a local vision-language model that accepts an image and a text prompt and returns a description, run through an existing runtime protocol (for example llama.cpp with a multimodal projector, if the owner already has it).
2. **Licence:** not researched in this increment. Required: the model weights licence and the projector licence, read from the official model card, with the date read.
3. **Download:** not researched. Required: the official file, size, and checksum from the publisher, and proof it can be downloaded on the owner machine.
4. **Owner-hardware evidence still needed:** the GPU or CPU memory and the runtime build the owner machine supports, and one measured description run on an owner-supplied image, reviewed by the owner before any use.
5. **Uncertainty:** the existing text planner (llama.cpp, Qwen text) does not see pixels. A text model must not be described as understanding images.

Recommended owner decision: keep manual descriptions as the default. Choose a vision runtime only after the four items above are supplied.

## Owner command (unchanged)

The transcription owner check is unchanged from `c2bf698`. The owner runs it on the owner host; it is not run here.
