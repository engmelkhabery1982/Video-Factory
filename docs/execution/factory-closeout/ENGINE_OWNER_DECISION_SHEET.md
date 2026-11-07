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
| Existing adapter | No production engine registration. The verified runner interface, strict mask/source/result checks, bounded versioned persistence, cancellation/retry/recovery, canonical Apply and ContentPlan UI are IMPLEMENTED in `masked-correction.ts`, `masked-correction-contract.ts`, `factory-service.ts` and `MaskedCorrectionPanel.tsx`. `createMockRunner` is explicitly fixture-only and refused in production. Routes include readiness/list/get/create/cancel/retry/review/apply/delete. A real inpainting runner is NOT RUN. |
| Official artifact | `runwayml/stable-diffusion-inpainting`, file `sd-v1-5-inpainting.ckpt`. SHA256 `c6bbc15e3224e6973459ba78de4998b80b50112b0ae5b5c67113d56b4e366b19`. Size 4,265,437,280 bytes (~4.27 GB). Licence: CreativeML Open RAIL-M (`creativeml-openrail-m`). A `.safetensors` variant also exists (SHA256 `3a754af8bc8f427ad3c5eabe134ecd6edf02eb7d1ff9d71a5294ba7f19f0bb90`, size 4,265,203,900 bytes). SHA/size are from the upstream Hugging Face file metadata; the file was NOT downloaded in the sandbox. Exact git revision of the main branch should be pinned before install. |
| Required hardware | Same as row 1 (GPU recommended). |
| Data flow | Canonically verified bound original + strict pixel mask → configured local runner → distinct corrected PNG/JPEG imported into the asset library with `factory` + `masked-correction-result` tags and exact job/run/original/mask provenance → measured byte/dimension/hash verification → original/result review → canonical revision-checked bind. The original asset is preserved. |
| Expected limits | No promise of exact logo/text/character fidelity; one job at a time, finite attempts/retention/file sizes and 15-minute maximum runner timeout. The original is never destroyed. An arbitrary valid library image or fixture is not accepted as the job result. |
| Minimum owner authorization | A scoped decision to add an inpainting runtime and register its verified adapter, including exact artifact/licence/hardware, canonical result-import provenance and one acceptance shot. No registration is authorized merely by this sheet. |
| Acceptance shot | One real masked correction on a synthetic/owned still on the owner host: original preserved, distinct measured result/provenance shown, owner visually reviews it, then explicit Apply/reopen confirms the binding. Fixture output never closes this row. |

## 3. Generated moving video (G6)

| Field | Value |
|---|---|
| Capability | Real generated moving video (not animated stills or procedural 2D) |
| Existing adapter | NONE accepted. The `screen_recording`/`footage_clip` shot types require SUPPLIED recordings, not generation. |
| Official artifact | **Candidate A (preferred):** `Wan2.2-TI2V-5B` — Alibaba. Repo: `Wan-AI/Wan2.2-TI2V-5B`. Licence: Apache-2.0 (commercially usable). Params: ~5B. Requires torch >= 2.4.0 and native Wan2.2 inference framework (not Diffusers). Supports text-to-video AND image-to-video. Official BF16 safetensors weight: 10.5 GB (from upstream Hugging Face file listing, not an estimate). Full repo: 34.2 GB. Output: 1280×704 at 24 fps. Minimum 24 GB VRAM on single GPU (RTX 4090) with model offloading and dtype conversion; 80 GB+ VRAM for full-speed execution. RTX 3060 (12 GB) is NOT sufficient at FP32. Quantized FP8 (5.1 GB) and INT8 (5.0 GB) variants exist from third-party repos but are not official weights. Exact SHA256 must be recorded from the owner's downloaded copy (not listed on model card). **Candidate B:** `Stable Video Diffusion XT` (`stabilityai/stable-video-diffusion-img2vid-xt`). Licence: Stability AI Community License (commercial use permitted with membership). Image-to-video only, 1024×576, 25 frames. Min VRAM 24 GB. Not text-to-video. **Candidate C:** `AnimateDiff-Lightning` (`ByteDance/AnimateDiff-Lightning`). Licence: Open (community). Min VRAM 8 GB. Animates existing SD stills; not standalone text-to-video. Candidate A is recommended for its permissive licence and dual T2V/I2V capability; the owner must confirm the exact revision/SHA/size from their download before any install. |
| Required hardware | GPU with substantial VRAM. Candidate A (Wan2.2-TI2V-5B): minimum 24 GB VRAM on single GPU (RTX 4090) with model offloading; 80 GB+ for full-speed without optimization. ~16 GB system RAM. RTX 3060 (12 GB) is NOT sufficient at FP32. Quantized variants may fit on 8 GB VRAM but are third-party, not official. Candidate B (SVD XT): ≥24 GB VRAM. Candidate C (AnimateDiff-Lightning): ≥8 GB VRAM. The sandbox and owner integrated graphics (AMD Radeon, no dedicated VRAM proven) are NOT verified sufficient. |
| Data flow | Prompt + optional reference → local video generation runner → review → bind as a generated-video slot (separate from procedural 2D). |
| Expected limits | No claim of arbitrary video generation; bounded jobs, cancellation, provenance, stable references required. |
| Minimum owner authorization | A scoped decision naming the exact engine + licence + hardware + budget + acceptance shot. |
| Acceptance shot | One real generated video clip, inspected for motion and identity, on the owner host. The separate installed Blender 4s synthetic proof is NOT factory integration and does not close this row. |

## 4. 3D (G6)

| Field | Value |
|---|---|
| Capability | Real 3D rendering |
| Existing adapter | NONE accepted. |
| Official artifact | **Candidate A (recommended):** Blender 4.x LTS + Cycles renderer. Repo: `blender/blender` (GPL v2+); Cycles: `blender/cycles` (Apache-2.0). Headless rendering: `blender --background --render-output <path> --render-engine cycles`. No per-node licence fees; commercial use permitted. Exact version/SHA must be recorded from the owner's installed copy. **Candidate B:** LuxCoreRender (GPL v3). **Candidate C:** Mitsuba 3 (MIT/Apache-2.0, but steeper integration). Blender is recommended: it is a complete 3D package with a proven headless render path, the owner already has a private Blender 4s proof, and Cycles' Apache-2.0 licence permits commercial use. |
| Required hardware | GPU recommended for Cycles GPU rendering; CPU-only rendering is feasible but slow (minutes per frame for complex scenes). Owner integrated graphics (AMD Radeon, no dedicated VRAM proven) may suffice for simple scenes but are NOT verified for production-quality 3D. |
| Data flow | Scene → local 3D render runner → review → bind. |
| Expected limits | Bounded jobs; no relabelling of procedural 2D as 3D. |
| Minimum owner authorization | A scoped decision naming the exact engine + licence + hardware + acceptance shot. |
| Acceptance shot | One real 3D render, inspected, on the owner host. The private Blender 4s proof is NOT imported and does not expand its permission. |

## 5. Talking characters / natural Arabic speech (G6 talking-character, G8)

| Field | Value |
|---|---|
| Capability | Natural Arabic/local speech + talking-character voice (separate from SAM robotic English and from Kokoro) |
| Existing adapter | `chatterbox-dialogue-synthesizer.ts`, `chatterbox-worker-protocol.ts`, `voice-audio` routes, Kokoro synthesizer. The Chatterbox adapter exists but no NATURAL Arabic output is accepted. SAM HTTP succeeded for robotic English only. |
| Official artifact | **Candidate A (recommended):** `silma-ai/silma-tts` (SILMA TTS v1) — bilingual Arabic/English, 150M params, F5-TTS diffusion architecture. Licence: Apache-2.0 (commercially usable). Repo: `github.com/SILMA-AI/silma-tts`. Hugging Face: `silma-ai/silma-tts`. Supports Arabic Fusha/MSA with Tashkeel (diacritization). RTF ~0.12 on RTX 4090 (official model card claim, not independently verified). Instant voice cloning with <8 s reference. **Candidate B:** `MBZUAI/speecht5_tts_clartts_ar` — SpeechT5 fine-tuned for Arabic. Licence: MIT (code) / model weights per MBZUAI terms. ~546 MB VRAM (fp16). **Candidate C:** `coqui/XTTS-v2` — MPL-2.0, multilingual (17 languages incl. Arabic), 467M params. Voice cloning requires consent. Note: Coqui AI shut down in Dec 2025; no official maintenance. Candidate A is recommended: permissive Apache-2.0 licence, lightweight 150M params, Arabic-native with diacritization, and no voice-cloning consent issues for the default speaker. Exact revision/SHA must be recorded from the owner's download before any install. |
| Required hardware | Candidate A (SILMA TTS): GPU recommended (RTX 4090 optimal, RTF ~0.12 is the official model card claim); CPU-only possible but slow. VRAM not specified in model card (estimate only). Candidate B (SpeechT5): ~546 MB VRAM (fp16, from model card). Candidate C (XTTS-v2): ~2.5 GB VRAM (estimate). Owner ~16 GB RAM should suffice for Candidate A/B. |
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
| Official artifact | **Candidate A (recommended):** whisper.cpp — C/C++ implementation of OpenAI Whisper ASR. Repo: `ggml-org/whisper.cpp`. Licence: MIT (code + model weights). Model: `ggml-org/whisper-ggml` (e.g. `ggml-large-v3.bin` or `ggml-medium.bin`). Supports 99 languages including Arabic. Word-level timestamps experimental; tinydiarize (speaker labels) experimental. CPU-only or GPU (CUDA/Metal/Vulkan). **Candidate B:** OpenAI Whisper (Python) — MIT licence, requires Python/PyTorch runtime. **Candidate C:** `Qwen3-ASR` — Apache-2.0, 30 languages, GPU recommended. whisper.cpp (Candidate A) is recommended: MIT licence, no Python runtime needed, CPU-feasible for short audio, and the owner machine (~16 GB RAM) should handle `ggml-medium.bin` (~1.5 GB) or `ggml-large-v3.bin` (~3 GB) comfortably. Exact model revision/SHA must be recorded from the owner's download before any install. |
| Required hardware | CPU-feasible for short audio (medium model: ~1.5 GB RAM; large-v3: ~3 GB RAM). GPU optional (CUDA/Metal/Vulkan acceleration available). Owner ~16 GB RAM is sufficient for medium or large-v3 on CPU. |
| Data flow | Supplied audio → local ASR runner → transcript → correction/review UI → scene plan/alignment. |
| Expected limits | Transcript is NOT word alignment; timing estimates stay labelled estimates; supplied speech order locked. |
| Minimum owner authorization | A scoped decision naming the exact ASR engine + licence + acceptance shot. |
| Acceptance shot | One real transcription of a synthetic/owned audio, correction-reviewed, on the owner host. |

---

## Summary of blocked rows

| Row | Capability | Candidate (recommended) | Blocked because | Decision required |
|---|---|---|---|---|
| 1 | Local vision + conditioning | SD 1.5 (`rundiffusion/sd-v1-5-pruned-emaonly`, CreativeML Open RAIL-M) | No local SD runtime in sandbox | Owner install/run SD 1.5 + acceptance shot |
| 2 | Masked/regional correction | `runwayml/stable-diffusion-inpainting` (`sd-v1-5-inpainting.ckpt`, SHA256 `c6bbc15e...`, CreativeML Open RAIL-M) | Contract implemented; engine runner absent | Owner install/run inpainting runtime + acceptance shot |
| 3 | Generated moving video | `Wan2.2-TI2V-5B` (Apache-2.0, 5.0B params, 10.5 GB BF16, min 24 GB VRAM) | No accepted runtime | Owner install/run candidate + acceptance shot |
| 4 | 3D | Blender 4.x + Cycles (GPL v2+ / Apache-2.0, headless render) | No accepted runtime | Owner install/run Blender + acceptance shot |
| 5 | Talking characters / natural Arabic | `silma-ai/silma-tts` (Apache-2.0, 150M, bilingual AR/EN) | No natural Arabic engine accepted | Owner install/run candidate + acceptance shot |
| 6 | Local semantic planner | `Qwen/Qwen2.5-1.5B-Instruct-GGUF` (Apache-2.0, pinned SHA256) | local_llm gated (no runtime here) | Owner download/run pinned Qwen GGUF + acceptance shot |
| 7 | Local transcription | whisper.cpp + `ggml-medium.bin`/`ggml-large-v3.bin` (MIT) | No real ASR runner here | Owner install/run candidate + acceptance shot |

No download, install, paid service or new provider permission is authorized by this sheet. Each row stays BLOCKED until the owner records the scoped decision and the acceptance shot is produced on the owner host.
