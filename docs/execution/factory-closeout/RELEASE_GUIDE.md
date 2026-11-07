# Factory release guide — operational release vs expanded-goal closure

**Generated 2026-11-07.** This guide covers how to start from each supported material, engine readiness, optional Google quota, local model/provenance licences, known limits, recovery/backup/restore, actual backend/data paths, source/licence records and the rollback manifest. It distinguishes a usable supported operational release from full expanded-goal closure. Owner creative/listening acceptance and unavailable heavyweight runtime gates remain explicit; no absolute all-video claim while PLAN rows remain open.

## 1. What is supported NOW (operational release)

The following paths work through final export with honest limits and recoverability, using the existing environment:

- **No material → topic starter → brief → local-rule draft.** Deterministic topic suggestions; no provider call. The local planner stays gated until the owner configures `LOCAL_LLM_ENABLED=1`.
- **Brief / script / storyboard / images / video → canonical draft → patchIntake → applyDraft → Editor → Captions → Export.** All within the existing draft/editor flow.
- **Text and JSON storyboard import** with exact ids/locks/wording/times and 409 conflict retention.
- **Built-in bounded PDF storyboard import** (zero-dependency parser; exact page order, panel ids, JPEG pictures, source/licence, atomic index writes).
- **Audio-only → transcription job contract** (fixture runner here; real ASR requires the owner runtime).
- **Video with/without audio → explicit original/replace/add/silent policy**, measured by ffprobe, mux via ffmpeg.
- **Procedural visual families** (motion-graphics, kinetic, numeric, process, actor, illustrated, mixed) rendered via Remotion on the owner host.
- **External narration import → listening approval → timing review → export gate** (VS4/VS5/VS6).
- **Consented screen/microphone/screen-with-audio capture** (typecheck fixed, lifecycle hardened this session) → asset library. Includes idempotent cleanup on unmount/cancel/error, `MediaRecorder` capability check, and audio-absence detection for screen-with-audio.
- **Editor** with save/undo/redo/revisions, graphic values, actors, kinetic/numeric/process labels, trim-boundary safety.
- **Export** with QC, frozen revision, portrait/landscape targets.

## 2. Engine readiness

| Engine | State in sandbox | Owner-host requirement |
|---|---|---|
| ffmpeg / ffprobe | Required for mux/measure | Must be installed (checked by `/api/health`) |
| Remotion / Chromium | Renderer (owner-host) | `npm run provision` builds the renderer |
| Local SD 1.5 (vision/conditioning) | BLOCKED — adapter exists, no runtime | Owner installs SD 1.5 at `F:/VideoFactory_Models/LocalGeneration/runtime/sd-cpu/sd-cli.exe` |
| Local planner (Qwen GGUF) | BLOCKED — gated by `LOCAL_LLM_ENABLED=1` | Owner downloads pinned Qwen GGUF + runs llama-server on loopback |
| Local ASR (transcription) | BLOCKED — fixture runner only | Owner installs whisper.cpp + ggml model (decision sheet row 7) |
| Kokoro (speech) | Adapter exists | Owner provisions `npm run provision:tts` |
| Chatterbox (voice clone) | Adapter exists | Owner provisions `npm run provision:voice-clone -- --apply` |
| Natural Arabic TTS | BLOCKED — adapter exists, no natural engine | Owner installs SILMA TTS or equivalent (decision sheet row 5) |
| Generated video | BLOCKED | Owner installs Wan2.2-TI2V-5B or equivalent (decision sheet row 3) |
| 3D | BLOCKED | Owner installs Blender 4.x + Cycles (decision sheet row 4) |

## 3. Optional Google quota

Google is **optional speech only**. It is never used for planning, vision, image or video. No call or spend happens without applicable authorization/budget. The spend ledger records exact additional external-call count before confirmation. No automatic provider switch, hidden retry, counter reset or unconfirmed spend after a quota error.

## 4. Local model / provenance licences

- **Qwen2.5-1.5B-Instruct-GGUF**: Apache-2.0 (recorded from the LICENSE file at the pinned revision).
- **Stable Diffusion 1.5**: CreativeML Open RAIL-M (owner records the exact licence from the upstream copy).
- **Kokoro / Chatterbox**: see their respective licence files (owner records).
- No private media, models, credentials or machine configs are committed to Git.

## 5. Known limits

- The local planner is a 1.5B model: semantic quality is not guaranteed for complex direction.
- SAM produces robotic English only; it is NOT a natural Arabic substitute.
- Procedural families are NOT generated video/3D/talking characters.
- The built-in PDF parser is bounded; owner-document PDFs and browser ingestion remain owner-host.
- Real browser capture (`getDisplayMedia`/`MediaRecorder`) is implemented and typecheck-clean but not executed in the sandbox. The component-level test file (`tests/web/capture-panel.test.tsx`) uses browser-API doubles and is NOT RUN here; it requires vitest/happy-dom on the owner host.
- No absolute all-video claim while G6/G7/G8 rows remain open.

## 6. Actual backend / data paths

| Path | Purpose |
|---|---|
| `DATA_DIR/factory/drafts/` | Factory drafts (canonical) |
| `DATA_DIR/assets/` + `index.json` | Asset library |
| `DATA_DIR/voice-audio/<id>/state.json` | External narration + voice-audio state |
| `DATA_DIR/.production/<id>/` | Production audio/plan scratch |
| `OUTPUT_DIR/` | Rendered videos and deliverables |
| `DATA_DIR/editor/` | Editor documents and frozen revisions |

`DATA_DIR` and `OUTPUT_DIR` default to `data/` and `output/` under the repo root and are git-ignored.

## 7. Recovery / backup / restore

- **Drafts** are stored as canonical JSON with revision counters; a 409 revision conflict protects concurrent edits.
- **Asset library** uses atomic index writes (temp file + rename); a corrupt index is surfaced, never silently replaced.
- **Production state** (`production-state.json`) tracks edits and staleness against input fingerprints.
- **Editor documents** support save/undo/redo and frozen revisions.
- **Backup**: copy `DATA_DIR` and `OUTPUT_DIR`. Restore by replacing those directories. No destructive cleanup is performed by the app.
- **Rollback manifest**: see `ROLLBACK_MANIFEST.md` (below).

## 8. Starting from each supported material

1. **No material**: open Content plan → pick a topic suggestion → edit brief → create draft.
2. **Topic only**: enter brief → create draft → three treatments appear → review → edit → apply.
3. **Script only**: paste script → create draft → visuals planned → optional speech → apply.
4. **Audio only**: upload audio → start transcription → correct/review → scene plan → apply.
5. **Pictures only**: upload images → assign roles → silent story or reviewed narrative → apply.
6. **Reference + topic/script**: upload references → analyze (requires SD runtime) → generate → review → bind → apply.
7. **Text storyboard**: paste or import text → edit panels → apply.
8. **Image/page storyboard**: upload images or PDF → import → review → apply.
9. **Video with audio**: upload video → choose original/replace/add/silent → apply.
10. **Video without audio**: upload video → silent or optional narration → apply.
11. **Mixed/conflicting**: supply all → resolve conflicts explicitly → locks respected → apply.

## 9. Operational release vs expanded-goal closure

- **Operational release** = the supported declared paths above work through final export with honest limits and recoverability. This is achievable NOW on the owner host with the provisioned engines.
- **Expanded-goal closure** = every targeted input/family has a functioning integrated engine and accepted output. This remains OPEN for G3 (real vision), G6 (generated video/3D/talking characters), G7 (masked correction), G8 (natural Arabic), and the local planner/ASR runtime gates. Unavailable engines leave those goals open.

## 10. Rollback manifest

See `ROLLBACK_MANIFEST.md` for the exact files changed this session and how to revert.
