# Local still images and local semantic planner: setup (owner's Windows computer)

Status: **setup procedure only. Not performed.** The factory did not download, install, run or change anything on the
owner's machine, and the build sandbox could not download the weights. Nothing here is local generation evidence until
the owner runs the steps and the acceptance steps in §7 pass on that computer.

Script: `scripts/windows/Setup-LocalGeneration.ps1` (one explicit PowerShell file; not run by the factory or by any build).

## 0. What runs where

| Part | Where | Google? | Spend |
|---|---|---|---|
| Stills (image shots) | `sd-cli.exe` (stable-diffusion.cpp) on this PC, one job at a time | No | None |
| Semantic planning (plans, treatments) | `llama-server.exe` (llama.cpp) bound to `127.0.0.1` | No | None |
| Optional speech | Gemini TTS (owner's free-tier key, budgeted, separate gates) | Yes, speech only | Free tier, budgeted |

Google is never used for images or planning. The factory refuses a loopback URL that is not `127.0.0.1`, `localhost` or `::1`.

Nothing here goes in Git. Runtime, weights, config, downloads and reports live under the root folder (default `F:\VideoFactory`).

## 1. The script and its switches

Run in PowerShell. Without a switch the script is **preflight only**: it reads the machine and writes nothing.

| Switch | Effect |
|---|---|
| (none) | Preflight: PowerShell and OS, RAM, display adapters (information only), free space on the root drive (about 6 GB needed), whether port 8080 is free. |
| `-Download -AcceptModelLicence` | Opt-in. Shows the four pinned URLs and sizes, asks you to type `YES`, then downloads about 3.3 GB. Each file is kept only if its size **and** SHA-256 match the pin. Otherwise it is deleted and the script stops. |
| `-Install` | Extracts the CPU runtime zips, runs `sd-cli.exe -h` and `llama-server.exe --help`, checks the printed flags, checks the model digests against the pins, and writes `config\local-generation.env.ps1`. |
| `-StartPlanner` | Starts `llama-server.exe -m <gguf> --host 127.0.0.1 --port 8080 -c 4096` minimised, and waits up to 180 s for `GET /health` to return 200. |
| `-Health` | Re-checks the flags, the model digest, the planner health, and that the planner listens on loopback only. Changes nothing. |

Each run writes `reports\setup-report-<time>.md` and `.json`, plus the captured help text. The report contains no secrets.

```powershell
.\Setup-LocalGeneration.ps1 -Root F:\VideoFactory                      # preflight only
.\Setup-LocalGeneration.ps1 -Root F:\VideoFactory -Download -AcceptModelLicence
.\Setup-LocalGeneration.ps1 -Root F:\VideoFactory -Install -StartPlanner -Health
```

Stop at the first `FAIL`. Do not use a file that the script refused.

## 2. Pinned sources, sizes and hashes

Every row was read from upstream metadata at the stated release or commit. None was produced by downloading the file in the
build sandbox. The download step recomputes the SHA-256 on your machine, and the script refuses a mismatch.

| Asset | Source (pinned URL) | Size (bytes) | SHA-256 | Licence |
|---|---|---|---|---|
| stable-diffusion.cpp `master-964-1d0a58a`, Windows x64 **CPU** zip (`sd-cli.exe`) | https://github.com/leejet/stable-diffusion.cpp/releases/download/master-964-1d0a58a/sd-master-1d0a58a-bin-win-cpu-x64.zip | 17,574,585 | `8e4e7bde781ff246817019a182040a087314caf4d21bc15fe4ff045167bd336d` (GitHub release digest) | MIT |
| llama.cpp `b11429`, Windows x64 **CPU** zip (`llama-server.exe`) | https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-win-cpu-x64.zip | 19,398,918 | `1283323272b04cd07905816a597a0da810918102de958f4ff6f7bbaa70ed2efe` (GitHub release digest) | MIT |
| Stable Diffusion v1.5 FP16 weights `v1-5-pruned-emaonly-fp16.safetensors` (Comfy-Org archive, commit `9cfd069101959ca3828bf9c04a4419870832b74f`) | https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/9cfd069101959ca3828bf9c04a4419870832b74f/v1-5-pruned-emaonly-fp16.safetensors | 2,132,696,762 | `e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916` (Hugging Face LFS object id) | CreativeML Open RAIL-M (use restrictions apply; you accept them) |
| Qwen2.5-1.5B-Instruct Q4_K_M GGUF `qwen2.5-1.5b-instruct-q4_k_m.gguf` (Qwen repo, commit `91cad51170dc346986eccefdc2dd33a9da36ead9`) | https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/91cad51170dc346986eccefdc2dd33a9da36ead9/qwen2.5-1.5b-instruct-q4_k_m.gguf | 1,117,320,736 | `6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e` (Hugging Face LFS object id) | Apache-2.0 (LICENSE at commit `91cad51`) |

Notes on the sources:

- The SD weights are an FP16 conversion with an added metadata header. They are not hash-identical to the original
  `runwayml` release. The pinned file is the Comfy-Org one.
- The Vulkan zip of stable-diffusion.cpp (`sd-master-1d0a58a-bin-win-vulkan-x64.zip`, 30,155,040 bytes, SHA-256
  `74211cb5c382aec2aeb086b64f2fdf525efec5faec4200a2d3257bc2328954ab`) is **not** in the script. It needs the Vulkan probe in §5.
- The factory's own pins live in `apps/api/src/services/local-image.ts` (`PINNED.model`) and
  `apps/api/src/services/local-planner.ts` (`LOCAL_PLANNER_PINNED`). They must match this table.

## 3. Flags (verified at the pinned commits, from upstream source)

**stable-diffusion.cpp `1d0a58a`** (`examples/common/common.cpp`, `examples/cli/main.cpp`). The adapter passes exactly:

- `-m` model path; `-p` prompt; `-n` negative prompt; `-W` width; `-H` height (default 512).
- `-s` seed (default 42; a negative value picks a random seed; batch images use `seed + index`).
- `-o` output path. A single result writes that exact path. Parent folders are created.
- `--steps` (default 20). `--cfg-scale` (float, default 7.0). The adapter uses 7.5.

`--rng` is not in these sources, so the adapter does not pass it. The script and the factory both check that `-h` prints
every name above. The check reads the help text of the binary you actually installed.

**llama.cpp `b11429`** (`tools/server/README.md`):

- `-m/--model`, `--host` (default `127.0.0.1`), `--port` (default 8080), `-c/--ctx-size`, `-n/--predict`, `-s/--seed`.
- `GET /health` returns 503 while the model loads, and 200 `{"status":"ok"}` when ready.
- `POST /v1/chat/completions` accepts `response_format: {"type":"json_object"}`. The planner sends this with `temperature 0.2`.
  The factory validates the JSON before it is used.

## 4. Environment (written by `-Install` to `config\local-generation.env.ps1`; never in Git, never in a URL)

Load it in the window that starts the factory: `. F:\VideoFactory\config\local-generation.env.ps1`. It contains:

```powershell
$env:LOCAL_IMAGE_ENABLED = '1'
$env:LOCAL_IMAGE_RUNNER = 'F:\VideoFactory\runtime\sd-cpu\...\sd-cli.exe'
$env:LOCAL_IMAGE_MODEL = 'F:\VideoFactory\models\v1-5-pruned-emaonly-fp16.safetensors'
$env:LOCAL_IMAGE_MODEL_SHA256 = '<the digest the script computed and compared with the pin>'
$env:LOCAL_IMAGE_BACKEND = 'cpu'
$env:LOCAL_IMAGE_STEPS = '20'
$env:LOCAL_IMAGE_TIMEOUT_SEC = '900'
$env:LOCAL_IMAGE_ROOT = 'F:\VideoFactory\local-images'
$env:LOCAL_LLM_ENABLED = '1'
$env:LOCAL_LLM_URL = 'http://127.0.0.1:8080'
$env:LOCAL_LLM_MODEL = 'qwen2.5-1.5b-instruct-q4_k_m'
$env:LOCAL_LLM_MODEL_LICENSE = 'Apache-2.0 (Qwen2.5-1.5B-Instruct-GGUF at commit 91cad51)'
$env:LOCAL_LLM_TIMEOUT_SEC = '180'
$env:LOCAL_LLM_MAX_TOKENS = '4096'
```

No Google variable is set here. Optional speech keeps its own settings.

Planner: the factory records the licence string you enter, and it reports `licenceMatchesPin`. It does not verify the file itself.
The script checks the GGUF size and SHA-256 against the pin before writing this file.

## 5. Vulkan (optional, only after a recorded probe)

The Vulkan zip is a different build. The backend is chosen by the zip you install, not by `LOCAL_IMAGE_BACKEND`, which only
labels the job. Vulkan is refused until `LOCAL_IMAGE_ROOT\vulkan-probe.json` exists with `{"ok": true, ...}`. Write that file
only after a successful generation with the Vulkan build on this PC. No CUDA assumption. No performance is promised. CPU is the baseline.

## 6. What the factory does and refuses

- Status (no generation): `GET /api/local-images/status` returns `ready`, `missing[]`, `flagsMissing[]`, `model.sha256Matches`,
  `model.recordedMatchesUpstream`, `model.upstreamSha256`, `googleUsed:false`. A missing runtime or model shows **setup required**.
- Planner status: `localPlannerStatus` returns `pinnedModel` and `licenceMatchesPin`. It is checked when a plan starts. A
  not-ready planner returns 412 `FACTORY_PROVIDER_DISABLED` with the reason. **No HTTP route exposes it yet** (named gap in §8).
- One job at a time. A second start returns 409 `LOCAL_IMAGE_BUSY`. Cancel kills the runner. Timeout kills the runner (`timed_out`).
- Output must decode as a complete 8-bit PNG of the requested size before anything is kept (signature, every chunk CRC, IHDR,
  inflated scanline length, IEND).
- Approve registers the file in the library with provenance (seed, prompt SHA-256, model SHA-256, dimensions, release, backend,
  output SHA-256) and the source and licence. Bind attaches it to the one image shot at the reviewed draft revision.
- Prompt export, a manual upload, or a copied prompt does not complete local generation.
- A still never satisfies a screen-recording shot.

## 7. Acceptance on the owner's computer (not yet done)

1. `-Install` passes, and `GET /api/local-images/status` returns `ready: true` with `model.sha256Matches: true`.
2. Generate one still from a real shot prompt. The preview appears only after success. Watch progress and try Cancel once.
3. Approve, then bind to the shot. Reload the page: the bind survives.
4. Check the provenance matches the model digest in §2 and the seed you used.
5. Start the planner with `-StartPlanner`, run `-Health`, and start one plan. A plan that is not ready returns 412 with the reason. Record the planner licence string you entered.
6. Record the duration, RAM use and whether the run stayed on CPU. Those numbers are the only performance evidence.

Until 1–6 are done on the owner's PC, local generation is **unproven**. Provider success, a fixture PNG, or a test double is not this.

## 8. Unverified and blocking items (named)

- The downloaded files' SHA-256 on the owner's PC (§2). The pins come from upstream metadata, not from a download in this sandbox.
- The installed `sd-cli.exe` and `llama-server.exe` help text (§3). The flag names come from the upstream source at the pinned commits.
- Licence acceptance by the owner for the SD weights (CreativeML Open RAIL-M).
- Real local planner output has not been produced by the pinned model.
- Vulkan probe (§5). CPU is the baseline. No generation time or quality is promised.
- No HTTP status route for the local planner (§6). Its readiness is only visible through plan-start refusals.
- Owner-host runs of §7. The PowerShell script has not been executed (no `pwsh` in the build sandbox).
