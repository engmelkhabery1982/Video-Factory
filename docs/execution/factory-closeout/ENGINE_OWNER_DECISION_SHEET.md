# Consolidated engine / owner decision sheet

**One sheet for every required engine that blocks full goal closure.** Generated 2026-11-07 from the authority/evidence matrix. Each row states the capability, the existing adapter, the official artifact/version/hash/size/licence, the required hardware vs known owner hardware, the data flow, expected limits, the exact minimum owner authorization, and the acceptance shot. An architecture recommendation is NOT permission to install. Unknown stays unknown.

## How to read this sheet

- **Existing adapter** = code already in the tree that calls the engine. It is NOT a proof of output.
- **Official artifact** = the exact upstream file/model the adapter expects. The SHA/size are recorded from the upstream metadata; the file was NOT downloaded in the build sandbox.
- **Required hardware** = what the engine needs to run acceptably. The known owner hardware is listed separately.
- **Minimum owner authorization** = the exact scoped decision the owner must make before any install/download/spend. It is NOT implied by this document.
- **Acceptance shot** = the smallest real output that would close the row. A fixture, refusal or skipped test does not close it.

---

## 1. Local vision + reference conditioning (G3, part of G7)

| Field | Value |
|---|---|
| Capability | Local image understanding (vision) + pixel-conditioned still generation + reference consistency |
| Existing adapter | `apps/api/src/services/local-image.ts`, `local-vision.ts`; routes `/api/factory/drafts/:id/visual-review`, `/bind-image`, `/api/local-vision`; core `conditioningRequestFor`, `bindLocalImage` |
| Official artifact | Stable Diffusion 1.5: `rundiffusion/sd-v1-5-pruned-emaonly` (or the owner's existing `models/v1-5-pruned-emaonly-fp16.safetensors`). Repo: `runwayml/stable-diffusion-v1-5`. Licence: CreativeML Open RAIL-M. The exact file, revision, size and SHA must be recorded from the owner's existing copy (the sandbox did not download it). |
| Required hardware | GPU strongly recommended (≥6 GB VRAM for fp16 512×512); CPU-only runs but is slow and may be unusable for the time budget. Owner machine: ~16 GB RAM, AMD Radeon Integrated Graphics (no dedicated VRAM proven). |
| Data flow | Supplied reference image bytes → local SD runner (loopback) → generated still → `bind-image` at reviewed revision → Editor. No cloud call. Reference bytes never leave the machine. |
| Expected limits | 512×512 default; reference conditioning strength 0.1–1.0; no guarantee of exact logo/text/character fidelity; religious pictures must not receive generated scripture/lettering/brand. |
| Minimum owner authorization | A scoped decision to install/run the existing SD 1.5 runtime on the owner host, with the recorded licence, plus an acceptance shot. |
| Acceptance shot | One real religious still-life and one educational reference, each visually compared with its reference, on the owner host. Fixture PNGs never prove conditioning. |

## 2. Masked / regional still correction (G7)

| Field | Value |
|---|---|
| Capability | Local masked/regional correction that preserves the original |
| Existing adapter | NONE. `correctStillPrompt` corrects the prompt text only; no masked inpainting path exists. |
| Official artifact | Stable Diffusion inpainting (same SD 1.5 checkpoint + `--inpaint` / mask input) or a dedicated inpainting model. Exact artifact/revision/SHA/size/licence must be recorded from upstream before any install. |
| Required hardware | Same as row 1 (GPU recommended). |
| Data flow | Original still + mask → local inpaint runner → corrected still (original preserved) → review → bind. |
| Expected limits | No promise of exact logo/text/character fidelity; the original is never destroyed. |
| Minimum owner authorization | A scoped decision to add an inpainting runtime + acceptance shot. |
| Acceptance shot | One real masked correction on a synthetic/owned still, original preserved, on the owner host. |

## 3. Generated moving video (G6)

| Field | Value |
|---|---|
| Capability | Real generated moving video (not animated stills or procedural 2D) |
| Existing adapter | NONE accepted. The `screen_recording`/`footage_clip` shot types require SUPPLIED recordings, not generation. |
| Official artifact | TBD by owner. Candidates (NOT selected here): a commercially usable text-to-video model with a clear licence. Exact repo/revision/SHA/size/licence/hardware required before any decision. |
| Required hardware | GPU with substantial VRAM (the sandbox and owner integrated graphics are NOT proven sufficient). |
| Data flow | Prompt + optional reference → local video generation runner → review → bind as a generated-video slot (separate from procedural 2D). |
| Expected limits | No claim of arbitrary video generation; bounded jobs, cancellation, provenance, stable references required. |
| Minimum owner authorization | A scoped decision naming the exact engine + licence + hardware + budget + acceptance shot. |
| Acceptance shot | One real generated video clip, inspected for motion and identity, on the owner host. The separate installed Blender 4s synthetic proof is NOT factory integration and does not close this row. |

## 4. 3D (G6)

| Field | Value |
|---|---|
| Capability | Real 3D rendering |
| Existing adapter | NONE accepted. |
| Official artifact | TBD by owner (e.g. Blender with a commercially usable licence, or another engine). Exact version/SHA/size/licence required. |
| Required hardware | GPU recommended; owner integrated graphics NOT proven sufficient for real-time 3D. |
| Data flow | Scene → local 3D render runner → review → bind. |
| Expected limits | Bounded jobs; no relabelling of procedural 2D as 3D. |
| Minimum owner authorization | A scoped decision naming the exact engine + licence + hardware + acceptance shot. |
| Acceptance shot | One real 3D render, inspected, on the owner host. The private Blender 4s proof is NOT imported and does not expand its permission. |

## 5. Talking characters / natural Arabic speech (G6 talking-character, G8)

| Field | Value |
|---|---|
| Capability | Natural Arabic/local speech + talking-character voice (separate from SAM robotic English and from Kokoro) |
| Existing adapter | `chatterbox-dialogue-synthesizer.ts`, `chatterbox-worker-protocol.ts`, `voice-audio` routes, Kokoro synthesizer. The Chatterbox adapter exists but no NATURAL Arabic output is accepted. SAM HTTP succeeded for robotic English only. |
| Official artifact | TBD by owner. A commercially usable Arabic TTS/voice model with a clear licence (no third-party voice cloning without consent). Exact repo/revision/SHA/size/licence required. |
| Required hardware | GPU recommended for natural-quality local synthesis; owner integrated graphics NOT proven sufficient. |
| Data flow | Reviewed script → local Arabic TTS runner → per-turn clips with source hashes → review → Apply. |
| Expected limits | Per-turn clips, speaker identity, cache/retry/restart, idempotent Apply must survive save/reopen. No duplicate original/added narration. |
| Minimum owner authorization | A scoped decision naming the exact Arabic engine + licence + hardware + acceptance shot. Google remains optional TTS only, never text/vision/image/video planning, never a hidden fallback. |
| Acceptance shot | One real Arabic speech clip, listening-reviewed by the owner, on the owner host. SAM/English samples and existing Kokoro code are NOT that proof. |

## 6. Local semantic planner (G1/G4/G5 — local_llm)

| Field | Value |
|---|---|
| Capability | Local semantic planning (script + 3 treatments from meaning) |
| Existing adapter | `apps/api/src/services/local-planner.ts` + `localPlanCompletion` wired into `gemini-service.ts` plan jobs. Gated by `LOCAL_LLM_ENABLED=1` + loopback URL + model label + licence. |
| Official artifact | Pinned in code: `Qwen/Qwen2.5-1.5B-Instruct-GGUF` revision `91cad51170dc346986eccefdc2dd33a9da36ead9`, file `qwen2.5-1.5b-instruct-q4_k_m.gguf`, size 1,117,320,736 bytes, upstream SHA256 `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e`, licence Apache-2.0, runtime `ggml-org/llama.cpp` release `b11429` `llama-server`. The file was NOT downloaded or run in the sandbox. |
| Required hardware | CPU-only feasible for a 1.5B Q4 model (loopback llama-server). Owner ~16 GB RAM should suffice; latency not verified here. |
| Data flow | Brief + references → loopback llama-server `/v1/chat/completions` → plan JSON → validate/repair → draft. No cloud call. |
| Expected limits | 1.5B model: quality not guaranteed for complex semantic direction; one repair pass; timeout 180 s default. |
| Minimum owner authorization | A scoped decision to download/run the pinned Qwen GGUF on the owner host + record the licence + acceptance shot. |
| Acceptance shot | One real local-planner run producing a validated 3-treatment draft, on the owner host. Until then the local_llm gate stays truthful (BLOCKED) and local_rules stays the only planner. |

## 7. Local transcription runner (G2)

| Field | Value |
|---|---|
| Capability | Independent local transcription of supplied audio |
| Existing adapter | `factory-transcription-runner` job contract + `tests/fixtures/transcription-runner-fixture.mjs` (FIXTURE only). Real ASR runner absent in sandbox. |
| Official artifact | TBD by owner (e.g. Whisper.cpp or another ASR). Exact artifact/revision/SHA/size/licence required. |
| Required hardware | CPU feasible for short audio; GPU optional. |
| Data flow | Supplied audio → local ASR runner → transcript → correction/review UI → scene plan/alignment. |
| Expected limits | Transcript is NOT word alignment; timing estimates stay labelled estimates; supplied speech order locked. |
| Minimum owner authorization | A scoped decision naming the exact ASR engine + licence + acceptance shot. |
| Acceptance shot | One real transcription of a synthetic/owned audio, correction-reviewed, on the owner host. |

---

## Summary of blocked rows

| Row | Capability | Blocked because | Decision required |
|---|---|---|---|
| 1 | Local vision + conditioning | No local SD runtime in sandbox | Owner install/run SD 1.5 + acceptance shot |
| 2 | Masked/regional correction | No inpainting path exists | Owner add inpainting runtime + acceptance shot |
| 3 | Generated moving video | No accepted runtime | Owner name engine + licence + hardware + acceptance shot |
| 4 | 3D | No accepted runtime | Owner name engine + licence + hardware + acceptance shot |
| 5 | Talking characters / natural Arabic | No natural Arabic engine accepted | Owner name Arabic TTS engine + licence + acceptance shot |
| 6 | Local semantic planner | local_llm gated (no runtime here) | Owner download/run pinned Qwen GGUF + acceptance shot |
| 7 | Local transcription | No real ASR runner here | Owner name ASR engine + acceptance shot |

No download, install, paid service or new provider permission is authorized by this sheet. Each row stays BLOCKED until the owner records the scoped decision and the acceptance shot is produced on the owner host.
