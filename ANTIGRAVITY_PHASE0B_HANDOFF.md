# Antigravity Phase 0B / 0B.1 Handoff: Target Audio User Interface and Safety

## 1. Summary
Phase 0B implements the isolated target-audio management interface for BuildTrack Video Factory.
Users can assign, replace, and remove distinct narration audio tracks for the Long video and each active Short (`short_1`, `short_2`, `short_3`) directly through an accessible UI without typing machine paths or editing project JSON.

## 2. API Endpoints Implemented
- `GET /api/projects/:id/target-audio`: Returns target presence, relative references, safe display filenames, durations, ready/missing statuses, actionable messages, and export block summaries.
- `POST /api/projects/:id/target-audio/:target`: Streams MP3/WAV/M4A uploads to a collision-resistant temporary file, enforces a 250 MB per-file limit, probes the completed file for a real audio stream and positive duration, and stores each validated replacement under a unique managed filename.
- `DELETE /api/projects/:id/target-audio/:target`: Clears and saves the selected project reference before deleting its managed file; it never touches external files or other targets and returns a cleanup warning if physical deletion fails.

## 3. UI Component & Integration
- `apps/web/src/components/TargetAudioPanel.tsx`:
  - Renders inside Captions & Assets (`apps/web/src/pages/Captions.tsx`).
  - Shows export readiness: "N of M narration tracks ready", blocking warnings, and plain language explanations.
  - Per-target cards with user-friendly names, Ready/Missing audio tags, filenames, measured durations, accessible Upload/Replace/Remove actions, and busy/error handling.
  - Remove is a two-step action with an accessible, target-named confirmation. Cancel performs no API call.
- `apps/web/src/lib/api.ts`: Added `targetAudio`, `uploadTargetAudio`, `deleteTargetAudio`.
- `apps/web/src/styles.css`: Added responsive styles for target-audio cards.

## 4. Safety & Boundary Guarantees
- **Storage Isolation**: Stored references are strictly relative (`voiceover/...`).
- **Target Independence**: Uploading/deleting Long modifies only `voiceoverFile`; Shorts modify only `targetAudio.short_N`.
- **Validation**: Rejects non-audio, corrupt headers, empty payloads, and Shorts absent from the storyboard.
- **Bounded Streaming**: Uploads are streamed to disk instead of buffered in memory. Oversized and truncated uploads return a client error and leave no partial file.
- **Transaction-safe Replacement**: A validated candidate receives a unique filename. The previous reference and audio remain intact until the new project state saves successfully. A partial-save failure restores the original project state and deletes the candidate.
- **Safe Deletion Order**: The project reference is cleared and persisted before managed-file cleanup. A cleanup failure cannot leave a project pointing at a deleted file.
- **Restricted Files Untouched**: No modifications made to core pipelines, rendering engines, scene timing, or Phase 0A files.

## 5. Deferred Timing Integration Point
- **Symbol / Hook**: `ANTIGRAVITY_PHASE0B_TIMING_INTEGRATION`
- **Location**: `apps/api/src/routes/target-audio.ts` (post-upload response) and `apps/web/src/components/TargetAudioPanel.tsx`.
- **Behavior**: Duration is captured and persisted, but storyboard re-timing is deliberately deferred to the timing agent. The user is prompted: `Regenerate the storyboard to apply the new audio timing.`

## 6. Phase 0B.1 Recovery and Verification Results
- **Recovery source**: `antigravity/phase-0b-target-audio-ui` at `4df21161aef9da94d570c0ded3f39fdc930c2ddd`, plus the interrupted local working tree recovered from `C:\Users\ASUS\.gemini\antigravity\scratch\Video-Factory`.
- **Targeted Tests**: 29 passing (21 backend API tests and 8 real component-interaction UI tests).
- **Full Test Suite**: 100 passing. The guard floor is 100 and its runner is cross-platform (direct Node execution of Vitest, not `npx`).
- **Strict Typecheck**: Core and Web pass with 0 errors.
- **Production Build**: Passes (`apps/web/dist`).
- **Environment Doctor**: All checks pass ([ok]).
- **Startup Smoke Test**: Verified health, target-audio endpoint, and static UI delivery on independent port.
- **Manual UI Verification**: Verified against `Video_01`, captured composite screenshot `EVIDENCE/phase-0b-narration-ui.png`.

## 7. Phase 0B.1 Regression Coverage
- Same-extension and different-extension replacements use new managed files and remove the previous managed candidate only after success.
- Invalid replacement audio preserves the original reference and original file.
- A simulated partial project-save failure restores the previous project JSON and audio.
- Oversized streaming uploads return HTTP 413 and leave no partial managed file.
- Real UI tests exercise upload success, upload failure, busy-state locking, named remove confirmation, cancellation without DELETE, confirmed target-only DELETE, and cleanup-warning display.
