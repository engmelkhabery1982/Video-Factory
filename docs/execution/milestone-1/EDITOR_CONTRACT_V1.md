# Shared editor contract v1 — implementation specification

Prepared 13 October 2026. These endpoints and fields are the agreed target for this work, not a claim that they already exist. Both implementers must use this exact specification. Report a necessary change; do not silently create incompatible interfaces.

## Baseline and ownership

Repository: engmelkhabery1982/Video-Factory.
Base commit: 04e46e87d1dc28a4d6ca57c4f865a226a78141bb.
Apply the attached content-led-reviewed-local.diff.txt first, after `git apply --check`. SHA256: 29398ab976be4c0e617ee967c4936c60b2b620cdb27f5c3ad734dc3034ecf377.

The patch includes the reviewed content-led changes and the scene-local Sequence fix for native video playback. Each tool works on a separate branch/workspace. Do not reset or modify owner data/output, upload model weights, push, merge or publish under these orders.

Arena owns `apps/api/**`, `packages/core/**`, `packages/video/**`, backend tests, and a project-scoped WSL runner if necessary. Freebuff owns `apps/web/**` and frontend tests. Neither changes package manifests/lockfiles, the other's files, authentication, or the approved recording without reporting the concrete need. Freebuff may write frontend-local DTO definitions following this document; Arena supplies the server DTO. Their JSON interface must match. Reuse installed dependencies and the existing renderer.

## Document and semantics

The persisted versioned document is the authority for the editor, preview and render. Use a sidecar or backward-compatible migration; preserve the original project and its approvals. Migrate only a derived copy for testing. A legacy source project must remain readable.

An editor document contains:

- `schemaVersion`: 1.
- `projectId`: string; `revision`: integer >= 0.
- `contentProfile`: religious | educational | promotional.
- `channelBrandId`: string or null; no automatic first-logo selection.
- `targetId`: long | short_1 | short_2 | short_3.
- `format`: landscape | portrait; `durationSec`: finite positive number.
- `assets`: asset references with `id`, `kind` (image | video | audio), `name`, `mediaUrl` (local served URL), `durationSec` (number or null), `source`, `license`, and `sha256` when measured. Non-empty metadata does not independently prove a license.
- `visualClips`: ordered clips with `id`, `sourceAssetId`, `startSec`, `durationSec`, `sourceInSec`, `sourceOutSec` (null for stills), `crop` ({x,y,width,height}, normalized source coordinates; default full frame), `motion` (none | slow_push | pan_left | pan_right), `transition` (cut | dissolve | fade), and `locked`.
- `audioClips`: clips with `id`, `sourceAssetId`, `speakerId` (string or null), `startSec`, `sourceInSec`, `sourceOutSec`, `gainDb`, `locked`, and `approved`. Preserve source bytes. Do not regenerate narration when visuals change. An approved audio trim/replacement must explicitly invalidate affected approvals; this milestone does not synthesize new voices.
- `captions`: `id`, `startSec`, `endSec`, `text`, `language`, `direction` (rtl | ltr), `fontSizePx`, `position` (normalized x/y), and `locked`. Retain complete words, shaping and diacritics. One caption need not equal one visual clip.
- `highlights`: `id`, `startSec`, `endSec`, `visualClipId`, `box` ({x,y,width,height}, normalized DISPLAY-frame coordinates), `label` (string or null), and `locked`. Show them only during their intervals. They are owner/editor annotations, not fabricated recorded cursor movements.
- `alignment`: unavailable | not_requested | running | proposed | approved, plus related audio hash, source revision and proposal ID when applicable. A transcript is not alignment, and an available model is not an executed result.

All numeric times are seconds. Source offsets and composition time are distinct. Image motion must be labeled still animation, not generated footage. Validate source ranges, finite numbers, clip bounds, caption intervals and exact media compatibility. No global offset or hardcoded 6.022. Preserve original audio/caption approvals unless their actual dependencies change.

## API target

Use existing error/status conventions when compatible, with this public envelope:

`GET /api/projects/:id/editor?targetId=long`
returns `{ document, undoAvailable, redoAvailable, capabilities }`.

`PATCH /api/projects/:id/editor`
body `{ targetId, baseRevision, operations }`, returns the same envelope. Persist atomically before returning success. Revision conflict: HTTP409 with `{code:"REVISION_CONFLICT", message, currentRevision}`. Never overwrite silently.

Each operation is one of:
- `{type:"insert", collection, item}`
- `{type:"update", collection, id, changes}`
- `{type:"remove", collection, id}`
- `{type:"reorder", collection:"visualClips", ids}`
- `{type:"split", collection:"visualClips", id, atSec}`
- `{type:"setDocument", changes}` for profile/brand/format only.

Collections: visualClips | audioClips | captions | highlights. Reorder means contiguous visual order while retaining each duration; recalculate visual starts only, not captions or audio. Split is at a composition time inside the selected clip and preserves its source position, total duration and visual result. Locked items reject mutation unless explicitly unlocked by an update changing only `locked:false`. No blanket editing around locks.

`POST /api/projects/:id/editor/undo` and `/redo`
body `{targetId,baseRevision}`, return the same envelope; revision increases on success. Restore a logical edit transaction and persist undo/redo availability. Do not implement “undo” as deleting the whole project.

`POST /api/projects/:id/editor/alignment`
body `{targetId,sourceAudioId}`, returns `{jobId,status:"running"}` when a real job starts. Structured blocker otherwise. Windows uses the EXISTING dedicated vf-align WSL runtime/model. No install/download and no shell command constructed from user text. Reuse cached emissions only when audio/script/config identity matches. Write a review proposal; do not auto-apply it.

`GET /api/projects/:id/editor/alignment/:jobId`
returns `{status,proposalId?,rows?,error?}`. Rows include sceneId/cueId, proposed source-time starts/ends and unresolved spans. Keep unavailable/failed explicit.

`POST /api/projects/:id/editor/alignment/:proposalId/accept`
body `{targetId,baseRevision,reviewed:true}`, validates the proposal identity against current inputs, applies the reviewed timing to affected captions/authority records, and returns the editor envelope. Owner-reviewed timing remains separate from synthesis rights or final publication approval.

`POST /api/projects/:id/editor/preview`
body `{targetId,baseRevision,range?:{startSec,endSec}}`, returns `{jobId,status:"running"}`. Reuse project-local rendering and job state; partial preview must use a frozen revision and correctly trim/rebase picture, audio and captions without changing the source document. Do not render a full minute to preview a 15-second range.

`GET /api/projects/:id/editor/preview/:jobId`
returns `{status,revision,range?,mediaUrl?,error?}`. The frontend must label a stale result, not display it as the current edit. Reuse existing file-serving checks.

`capabilities` reports unavailable engines truthfully; not every contract field implies a working generator. Imported storyboard and audio-only transcription are later milestones, not silently claimed in this first editor delivery.

## Acceptance protocol

Backend and frontend can run in parallel using this fixed contract. A frontend fixture may be used in an explicitly labeled development mode; it must never turn server failure into a successful save, alignment or render in normal mode. Contract tests and a mocked frontend are not end-to-end acceptance.

After integration, Windows acceptance must complete import/bind → edit/cut/reorder → undo/redo → save/reopen → timed highlight/RTL captions → short preview from the same document. Compare the rendered revision, source hashes and selected timestamps. Real Excel footage must move and start at the correct source offset. Existing approved original WAV/project/state remain unchanged. Run no full render or publication until this bounded cycle passes.
