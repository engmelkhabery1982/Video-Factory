# Antigravity Phase 0B Handoff: Target Audio User Interface

## 1. Summary
Phase 0B implements the isolated target-audio management interface for BuildTrack Video Factory.
Users can assign, replace, and remove distinct narration audio tracks for the Long video and each active Short (`short_1`, `short_2`, `short_3`) directly through an accessible UI without typing machine paths or editing project JSON.

## 2. API Endpoints Implemented
- `GET /api/projects/:id/target-audio`: Returns target presence, relative references, safe display filenames, durations, ready/missing statuses, actionable messages, and export block summaries.
- `POST /api/projects/:id/target-audio/:target`: Validates target ID, project storyboard presence, format (MP3, WAV, probed M4A), audio streams, and positive duration. Writes atomically to managed `data/voiceover/{videoId}_{target}.{ext}`.
- `DELETE /api/projects/:id/target-audio/:target`: Safely unlinks managed audio for that target only; never touches external files or other targets.

## 3. UI Component & Integration
- `apps/web/src/components/TargetAudioPanel.tsx`:
  - Renders inside Captions & Assets (`apps/web/src/pages/Captions.tsx`).
  - Shows export readiness: "N of M narration tracks ready", blocking warnings, and plain language explanations.
  - Per-target cards with user-friendly names, Ready/Missing audio tags, filenames, measured durations, accessible Upload/Replace/Remove actions, and busy/error handling.
- `apps/web/src/lib/api.ts`: Added `targetAudio`, `uploadTargetAudio`, `deleteTargetAudio`.
- `apps/web/src/styles.css`: Added responsive styles for target-audio cards.

## 4. Safety & Boundary Guarantees
- **Storage Isolation**: Stored references are strictly relative (`voiceover/...`).
- **Target Independence**: Uploading/deleting Long modifies only `voiceoverFile`; Shorts modify only `targetAudio.short_N`.
- **Validation**: Rejects non-audio, corrupt headers, empty payloads, and Shorts absent from the storyboard.
- **Atomic File Handling**: Uses temporary file validation before atomic rename; cleans up temporary files on rejection.
- **Restricted Files Untouched**: No modifications made to core pipelines, rendering engines, scene timing, or Phase 0A files.

## 5. Deferred Timing Integration Point
- **Symbol / Hook**: `ANTIGRAVITY_PHASE0B_TIMING_INTEGRATION`
- **Location**: `apps/api/src/routes/target-audio.ts` (post-upload response) and `apps/web/src/components/TargetAudioPanel.tsx`.
- **Behavior**: Duration is captured and persisted, but storyboard re-timing is deliberately deferred to the timing agent. The user is prompted: `Regenerate the storyboard to apply the new audio timing.`

## 6. Verification Results
- **Targeted Tests**: 20 passing (16 backend API in `tests/target-audio-api.test.ts`, 4 UI in `tests/target-audio-ui.test.ts`).
- **Full Test Suite**: 91 passing (71 baseline + 20 Phase 0B tests).
- **Strict Typecheck**: Core and Web pass with 0 errors.
- **Production Build**: Built in < 1s (`apps/web/dist`).
- **Environment Doctor**: All checks pass ([ok]).
- **Startup Smoke Test**: Verified health, target-audio endpoint, and static UI delivery on independent port.
- **Manual UI Verification**: Verified against `Video_01`, captured composite screenshot `EVIDENCE/phase-0b-narration-ui.png`.
