# Factory release guide — operational release vs expanded-goal closure

**Generated 2026-11-07.** This guide covers how to start from each supported material, engine readiness, optional Google quota, local model/provenance licences, known limits, recovery/backup/restore, actual backend/data paths, source/licence records and the rollback manifest. It distinguishes a usable supported operational release from full expanded-goal closure. Owner creative/listening acceptance and unavailable heavyweight runtime gates remain explicit; no absolute all-video claim while PLAN rows remain open.

## 1. Implemented operational paths — NOT a new release approval

The existing reviewed baseline contains the following operational paths. CLOSEOUT04 changes are **owner-host review pending**, and this list is not a claim that every path was rerun or accepted in Arena. Final export, browser and engine evidence remain separately labelled in the matrix:

- **No material → topic starter → brief → local-rule draft.** Deterministic topic suggestions; no provider call. The local planner stays gated until the owner configures `LOCAL_LLM_ENABLED=1`.
- **Brief / script / storyboard / images / video → canonical draft → patchIntake → applyDraft → Editor → Captions → Export.** All within the existing draft/editor flow.
- **Text and JSON storyboard import** with exact ids/locks/wording/times and 409 conflict retention.
- **Built-in bounded PDF storyboard import** (zero-dependency parser; exact page order, panel ids, JPEG pictures, source/licence, atomic index writes).
- **Audio-only → transcription job contract** (fixture runner here; real ASR requires the owner runtime).
- **Video with/without audio → explicit original/replace/add/silent policy**, measured by ffprobe, mux via ffmpeg.
- **Procedural visual families** (motion-graphics, kinetic, numeric, process, actor, illustrated, mixed) rendered via Remotion on the owner host.
- **External narration import → listening approval → timing review → export gate** (VS4/VS5/VS6).
- **Masked/regional still-correction workflow** in ContentPlan: bound-original selection, bounded pixel mask/instruction, persisted jobs, provenance, original/result comparison, review/reject/retry/cancel/cleanup and explicit Apply. CLOSEOUT05 adds an opt-in sd-cli production adapter and canonical result importer; submission remains honestly blocked until an authorized local model and the verified runner interface pass registration.
- **Consented screen/microphone/screen-with-audio capture** → captured Blob review → asset library. Includes non-autoplay video/audio controls, object-URL cleanup on Discard/unmount, idempotent stream cleanup, `MediaRecorder` capability gating, audio-absence detection, upload-failure retry, and synchronous refusal to replace a completed/uploading/uploaded capture. Current component/type/build/browser checks remain owner-host gates.
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
| Masked/regional correction | BLOCKED — opt-in sd-cli adapter, startup probe/registration, durable jobs, canonical result import/Apply and ContentPlan UI implemented; no model/runtime present or executed here | Owner supplies the separately authorized SD inpainting artifact, configures the contract below, passes startup probe and produces/reviews one real corrected output |

### Masked-correction sd-cli configuration (existing authorized local files only)

CLOSEOUT05 uses the same existing `stable-diffusion.cpp` CLI family as local stills; it does not install a runner or model. The verified interface is upstream commit `1d0a58a35050d285b1d6fb1bc68a92924d35825e` (`--init-img`, one-channel `--mask`, `--strength`, explicit source dimensions and PNG output). White pixels are the union of regions to inpaint; black preserves the source.

After the owner has separately authorized and supplied the exact inpainting artifact, set these in the owner's local launch environment (never commit them):

```text
MASKED_CORRECTION_ENABLED=1
MASKED_CORRECTION_RUNNER=<existing sd-cli path>
MASKED_CORRECTION_MODEL=<authorized sd-v1-5-inpainting.ckpt or .safetensors path>
MASKED_CORRECTION_MODEL_SHA256=<exact lowercase artifact SHA-256>
```

`MASKED_CORRECTION_RUNNER` may be omitted only to reuse the existing `LOCAL_IMAGE_RUNNER`; the base still-image model is never reused as an inpainting model. Production accepts only the two artifact hashes in the decision sheet and hashes the actual file. Optional bounded settings are `MASKED_CORRECTION_STEPS` (4–40, default 20), `MASKED_CORRECTION_TIMEOUT_SEC` (60–900, default 900), `MASKED_CORRECTION_STRENGTH` (0.05–1, default 1), `MASKED_CORRECTION_CFG_SCALE` (1–30, default 7.5), and `MASKED_CORRECTION_ROOT` (dedicated scratch root; normally unset).

Startup and every run check the real `sd-cli -h` flags and model hash. Partial/invalid configuration leaves readiness false with actionable setup details and does not persist a new job. A successful run imports a run-specific PNG with exact original/mask/model/result hashes and job/run/interface provenance. It never overwrites the original. Cancellation kills the child and late output is not imported. No successful registration or fixture test is evidence of a real corrected image or its quality.

## 3. Optional Google quota

Google is **optional speech only**. It is never used for planning, vision, image or video. No call or spend happens without applicable authorization/budget. The spend ledger records exact additional external-call count before confirmation. No automatic provider switch, hidden retry, counter reset or unconfirmed spend after a quota error.

## 4. Local model / provenance licences

- **Qwen2.5-1.5B-Instruct-GGUF**: Apache-2.0 (recorded from the LICENSE file at the pinned revision).
- **Stable Diffusion 1.5**: CreativeML Open RAIL-M (owner records the exact licence from the upstream copy).
- **Stable Diffusion inpainting** (`runwayml/stable-diffusion-inpainting`, `sd-v1-5-inpainting.ckpt`): CreativeML Open RAIL-M. SHA256 `c6bbc15e3224e6973459ba78de4998b80b50112b0ae5b5c67113d56b4e366b19`, size 4,265,437,280 bytes (from upstream Hugging Face metadata; not downloaded in sandbox).
- **Kokoro / Chatterbox**: see their respective licence files (owner records).
- No private media, models, credentials or machine configs are committed to Git.

## 5. Known limits

- The local planner is a 1.5B model: semantic quality is not guaranteed for complex direction.
- SAM produces robotic English only; it is NOT a natural Arabic substitute.
- Procedural families are NOT generated video/3D/talking characters.
- The built-in PDF parser is bounded; owner-document PDFs and browser ingestion remain owner-host.
- Real browser capture (`getDisplayMedia`/`MediaRecorder`) and captured Blob review are implemented but not executed in the sandbox. The expanded 32-case component file (`tests/web/capture-panel.test.tsx`) uses browser-API/object-URL doubles and is NOT RUN here; it requires vitest/happy-dom on the owner host. Current TypeScript/build checks are also NOT RUN because those tools are absent.
- No absolute all-video claim while G6/G7/G8 rows remain open.

## 6. Actual backend / data paths

| Path | Purpose |
|---|---|
| `DATA_DIR/factory/drafts/` | Factory drafts (canonical) |
| `DATA_DIR/factory/masked-corrections/jobs/` | Versioned masked-correction jobs and recovery markers (bounded files/retention; includes no engine by itself) |
| `DATA_DIR/factory/masked-corrections/sd-cli/work/` | Disposable per-run frozen original/mask/unimported output; removed after each run and at configured startup after the busy guard. Canonical results are instead stored in `DATA_DIR/assets/` |
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
- **Versioned masked jobs**: durable JSON plus atomic draft Apply markers. Startup marks unfinished runner work interrupted; only an exact committed Apply marker can reconcile an `applying` job. A missing output is never reported as resumed success.
- **Offline backup/verify/restore**: `scripts/factory-data-recovery.mjs` uses SHA-256 manifests, refuses symlinks/traversal/duplicate or extra files, and never merges into or overwrites a nonempty destination. Stop the server first. Backups may contain private media: keep them outside Git and do not upload them.

Owner-host example (new backup names; the tool refuses to overwrite an existing backup):

```powershell
New-Item -ItemType Directory -Path ..\VideoFactory-Backups -Force
node scripts/factory-data-recovery.mjs backup --data data --output ..\VideoFactory-Backups\data-closeout04
node scripts/factory-data-recovery.mjs backup --data output --output ..\VideoFactory-Backups\output-closeout04
node scripts/factory-data-recovery.mjs verify --backup ..\VideoFactory-Backups\data-closeout04
node scripts/factory-data-recovery.mjs verify --backup ..\VideoFactory-Backups\output-closeout04
```

Restore is deliberately non-destructive and must target an absent or empty directory, not the live owner data. Verify both backup and restored hashes, review the result, and only then make a separate owner decision about configuration/root switching:

```powershell
node scripts/factory-data-recovery.mjs restore --backup ..\VideoFactory-Backups\data-closeout04 --data ..\VideoFactory-Restored-Data --yes
node scripts/factory-data-recovery.mjs restore --backup ..\VideoFactory-Backups\output-closeout04 --data ..\VideoFactory-Restored-Output --yes
node scripts/factory-data-recovery.mjs verify --backup ..\VideoFactory-Backups\data-closeout04
```

A failed restore can leave a partial NEW destination for diagnosis; the tool never deletes it or the source backup. This is not a live/hot backup protocol and does not prove render-engine recovery.
- **Rollback manifest**: see `ROLLBACK_MANIFEST.md`.

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

- **Operational release** = the supported declared paths above work through final export with honest limits and recoverability. The owner must complete the finite host checklist for the integrated CLOSEOUT04 tree before making that release decision; Arena has not certified it.
- **Expanded-goal closure** = every targeted input/family has a functioning integrated engine and accepted output. This remains OPEN for G3 (real vision), G6 (generated video/3D/talking characters), G7 (masked correction), G8 (natural Arabic), and the local planner/ASR runtime gates. Unavailable engines leave those goals open.

## 10. Rollback manifest

See `ROLLBACK_MANIFEST.md` for the exact files changed this session and how to revert.
