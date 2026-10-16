# Local picture analysis and reference-conditioned stills: owner setup

Status: **BLOCKED on the owner runtime.** The adapters, routes, UI and tests are complete. Real execution has not run: the
runtime files are not on the sandbox. Fixture and loopback-stub evidence does not prove generation or picture understanding.

## One manifest, one command

- Manifest (exact names, sizes, SHA-256 pins, licences, env vars): `scripts/local-visual/manifest.json`
- Verification (resumable, no downloads, no provider calls, no generation, no model load):

```powershell
node scripts/verify-local-visual.mjs --root data\local-visual-verify
```

Exit codes: `0` every required item passes · `1` a check failed (fix it, re-run) · `2` blocked (place the missing item,
set its env var, re-run; passed steps are kept in `data/local-visual-verify/state.json`).

The verifier writes `data/local-visual-verify/report.json` (no secrets, no picture content). `data/` is git-ignored.

## Pins (all from upstream release or repo metadata)

| Item | Pin | Licence |
|---|---|---|
| llama.cpp `b11429` Windows CPU x64 zip (planner and vision server) | SHA-256 `1283323272b04cd07905816a597a0da810918102de958f4ff6f7bbaa70ed2efe`, 19,398,918 bytes | MIT |
| Qwen2-VL-2B-Instruct Q4_K_M (vision model), `ggml-org/Qwen2-VL-2B-Instruct-GGUF` @ `bb307c03…` | SHA-256 `5745685d2e607a82a0696c1118e56a2a1ae0901da450fd9cd4f161c6b62867d7`, 986,046,944 bytes | Apache-2.0 (repo metadata) |
| mmproj Q8_0 (vision projector) | SHA-256 `a0ad91f00a7a80dcf84d719a61b00ee2e07b71794f4ee2dfa81a254621a8c418`, 709,883,360 bytes | Apache-2.0 (repo metadata) |
| sd-cli `sd-master-1d0a58a` Windows CPU zip | SHA-256 `8e4e7bde781ff246817019a182040a087314caf4d21bc15fe4ff045167bd336d`, 17,574,585 bytes | MIT |
| SD 1.5 base (existing), Comfy-Org fp16 | SHA-256 `e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916`, 2,132,696,762 bytes | CreativeML Open RAIL-M (use restrictions; owner review) |
| IP-Adapter SD1.5, `h94/IP-Adapter` @ `018e4027…` | SHA-256 `289b45f16d043d0bf542e45831f971dcdaabe18b656f11e86d9dfba7e9ee3369`, 44,642,768 bytes | Apache-2.0 (repo card) |
| CLIP Vision ViT-H/14 (image encoder), same repo | SHA-256 `6ca9667da1ca9e0b0f75e46bb030f7e011f44f86cbfb8d5a36590fcd7507b030`, 2,528,373,448 bytes | Apache-2.0 (repo card); upstream OpenCLIP licence is an owner review item |

Notes: the llama.cpp digest is the one GitHub reports for the `b11429` release asset (the same value is in
`docs/execution/milestone-3/LOCAL_IMAGE_SETUP.md`). The `b11690` asset hash belongs to another release and is not used.
Hashes of Hugging Face LFS files were read from the repository tree API at the pinned revision.

## Environment (set on the owner host; never commit values)

```text
VISION_ENABLED=1
VISION_URL=http://127.0.0.1:8081          # loopback only; the app refuses any other host
VISION_MODEL_PATH=<vision model .gguf>     VISION_MODEL_SHA256=<its SHA-256>
VISION_PROJECTOR_PATH=<mmproj .gguf>       VISION_PROJECTOR_SHA256=<its SHA-256>
LOCAL_IMAGE_ENABLED=1
LOCAL_IMAGE_RUNNER=<sd-cli.exe>            LOCAL_IMAGE_MODEL=<SD 1.5 fp16>   LOCAL_IMAGE_MODEL_SHA256=<its SHA-256>
LOCAL_IMAGE_IP_ADAPTER=<ip-adapter_sd15.safetensors>  LOCAL_IMAGE_IP_ADAPTER_SHA256=<its SHA-256>
LOCAL_IMAGE_CLIP_VISION=<clip_vision_h.safetensors>   LOCAL_IMAGE_CLIP_VISION_SHA256=<its SHA-256>
VF_SD_ZIP=<sd-master-1d0a58a-bin-win-cpu-x64.zip>     VF_LLAMA_ZIP=<llama-b11429-bin-win-cpu-x64.zip>
VF_LLAMA_SERVER_EXE=<llama-server.exe>
```

Owner-host paths given: `F:\VideoFactory_Models\LocalGeneration\runtime\sd-cpu\sd-cli.exe` and
`F:\VideoFactory_Models\LocalGeneration\models\v1-5-pruned-emaonly-fp16.safetensors`. The other locations in the manifest are
suggestions. Set the env vars to the real files.

Start the vision server only on loopback, once the verifier passes (check the flags with `llama-server.exe --help` first):

```powershell
llama-server.exe --host 127.0.0.1 --port 8081 -m <vision model .gguf> --mmproj <mmproj .gguf>
```

## What is and is not proven

- Fixture and loopback-stub tests prove the protocol, the strict parse, timeout, cancel, late-answer discard, busy, recovery,
  the picture bytes sent, the copied reference passed to the runner, staleness, refusals and save/reopen. They do not prove
  that a model reads a picture correctly or that a still is good.
- Pair A (religious still-life) and Pair B (educational truck) are **UNPROVEN** until the owner runtime runs them and the
  owner reviews the result.
- Not claimed: lip-sync, generative video, 3D.
- The browser acceptance gate is BLOCKED: no runnable browser on this sandbox. DOM tests are not browser evidence.
