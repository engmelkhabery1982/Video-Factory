# Local still images and local semantic planner: setup (owner's Windows computer)

Status: **setup procedure only. Not performed.** The factory did not download, install or change anything on the
owner's machine. Nothing here is local generation evidence until the owner runs it and the acceptance steps in §6 pass
on that computer.

## 0. What runs where

| Part | Where | Google? | Spend |
|---|---|---|---|
| Stills (image shots) | `sd-cli.exe` (stable-diffusion.cpp) on this PC, one job at a time | No | None |
| Semantic planning (plans, treatments) | `llama-server` (llama.cpp) on `127.0.0.1` | No | None |
| Optional speech | Gemini TTS (owner's free-tier key, budgeted, separate gates) | Yes, speech only | Free tier, budgeted |

Google is never used for images or planning. The factory refuses a loopback URL that is not `127.0.0.1`, `localhost` or `::1`.

Nothing here goes in Git. Runtime, weights and outputs live under `F:\` (paths below are examples; use your own).

## 1. Pinned runtime (stable-diffusion.cpp)

Source: https://github.com/leejet/stable-diffusion.cpp/releases/tag/master-964-1d0a58a
(release published 2026-10-13; target commit `1d0a58a35050d285b1d6fb1bc68a92924d35825e`). Licence: **MIT**.

| Asset | Size (bytes) | SHA-256 (GitHub release digest) |
|---|---|---|
| `sd-master-1d0a58a-bin-win-cpu-x64.zip` (**CPU baseline**) | 17,574,585 | `8e4e7bde781ff246817019a182040a087314caf4d21bc15fe4ff045167bd336d` |
| `sd-master-1d0a58a-bin-win-vulkan-x64.zip` (optional, needs a probe) | 30,155,040 | `74211cb5c382aec2aeb086b64f2fdf525efec5faec4200a2d3257bc2328954ab` |

Steps (PowerShell, owner runs):

```powershell
New-Item -ItemType Directory -Force F:\VideoFactory\runtime\sd-cpu | Out-Null
# Download the zip from the release page above into F:\VideoFactory\downloads\ (browser or Invoke-WebRequest).
$zip = 'F:\VideoFactory\downloads\sd-master-1d0a58a-bin-win-cpu-x64.zip'
(Get-Item $zip).Length                                  # must be 17574585
(Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower()    # must be 8e4e7bde781ff246817019a182040a087314caf4d21bc15fe4ff045167bd336d
Expand-Archive $zip F:\VideoFactory\runtime\sd-cpu -Force
```

Stop if a size or hash differs. Do not use the file.

**Flags are unverified until you read them.** The adapter passes `-m -p -n -W -H -s -o --steps --cfg-scale` (and `--rng cpu`).
The upstream README confirms `sd-cli` and `-m`/`-p`; the other names must be checked against the binary you installed:

```powershell
F:\VideoFactory\runtime\sd-cpu\sd-cli.exe -h > F:\VideoFactory\runtime\sd-cpu-help.txt
```

The factory's status check reads the same help text and lists any required flag it does not find. If one is missing,
the factory stays on "setup required". Do not edit the adapter to suit a different build without a new review.

## 2. Pinned model (Stable Diffusion 1.5, lightweight SD 1.x)

Chosen for CPU use on a Ryzen 9 5900HX with 15.4 GiB RAM. Lower-precision weights use less memory.

- Official source: https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5 (file `v1-5-pruned-emaonly.safetensors`, about 4.27 GB, full precision).
- Smaller conversion: `v1-5-pruned-emaonly-fp16.safetensors`, about **2.13 GB**, listed at https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive.
- Licence: **CreativeML Open RAIL-M**. Use restrictions apply and are part of the licence. The owner must read and accept them before use.
- The SHA-256 of these weights was **not verified** by the factory (the source could not be reached from the build sandbox; the Hugging Face Xet hash is not a SHA-256). The owner computes it from the file they downloaded and records it in `LOCAL_IMAGE_MODEL_SHA256`:

```powershell
(Get-FileHash -Algorithm SHA256 F:\VideoFactory\models\sd15\v1-5-pruned-emaonly-fp16.safetensors).Hash.ToLower()
```

Record the result, the source URL, the download date and the licence acceptance in your own notes (outside Git).

## 3. Environment (set for the server process only; never in Git, never in a URL)

```powershell
$env:LOCAL_IMAGE_ENABLED = '1'
$env:LOCAL_IMAGE_RUNNER = 'F:\VideoFactory\runtime\sd-cpu\sd-cli.exe'
$env:LOCAL_IMAGE_MODEL = 'F:\VideoFactory\models\sd15\v1-5-pruned-emaonly-fp16.safetensors'
$env:LOCAL_IMAGE_MODEL_SHA256 = '<the 64-hex value you computed in §2>'
$env:LOCAL_IMAGE_BACKEND = 'cpu'                      # 'vulkan' only after §4
$env:LOCAL_IMAGE_STEPS = '20'                         # 4 to 40
$env:LOCAL_IMAGE_TIMEOUT_SEC = '900'                  # 60 to 3600
$env:LOCAL_IMAGE_ROOT = 'F:\VideoFactory\local-images' # job files and candidate PNGs (outside Git)
```

Semantic planner (llama.cpp, MIT; choose a model you have checked the licence of):

```powershell
$env:LOCAL_LLM_ENABLED = '1'
$env:LOCAL_LLM_URL = 'http://127.0.0.1:8080'
$env:LOCAL_LLM_MODEL = '<label you choose, for example qwen2.5-1.5b-instruct-q4_k_m>'
$env:LOCAL_LLM_MODEL_LICENSE = '<licence you verified for that exact file>'
# optional: LOCAL_LLM_TIMEOUT_SEC (10 to 900, default 180), LOCAL_LLM_MAX_TOKENS (256 to 8192, default 4096)
```

The planner candidate (Qwen2.5-1.5B-Instruct GGUF; base model Apache-2.0; community GGUF repackagers) was **not installed or
tested** here. The factory records the licence you enter; it does not verify it. Serve it with `llama-server` on
`127.0.0.1:8080` only (do not bind to `0.0.0.0`).

## 4. Vulkan (optional, only after a recorded probe)

The Vulkan zip is a different build. The backend is chosen by the zip you install, not by `LOCAL_IMAGE_BACKEND`, which only
labels the job. Vulkan is refused until `LOCAL_IMAGE_ROOT\vulkan-probe.json` exists with `{"ok": true, ...}`. Write that file
only after a successful generation with the Vulkan build on this PC. No CUDA assumption. No performance is promised.

## 5. What the factory does and refuses

- Status (no generation): `GET /api/local-images/status` → `ready`, `missing[]`, `flagsMissing[]`, `model.sha256Matches`, `googleUsed:false`.
- One job at a time. A second start returns 409 `LOCAL_IMAGE_BUSY`. Cancel kills the runner. Timeout kills the runner (`timed_out`).
- Output must decode as a complete 8-bit PNG of the requested size before anything is kept (signature, every chunk CRC, IHDR, inflated scanline length, IEND).
- Approve registers the file in the library with provenance (seed, prompt SHA-256, model SHA-256, dimensions, release, backend, output SHA-256) and the source and licence. Bind attaches it to the one image shot at the reviewed draft revision.
- Prompt export, a manual upload, or a copied prompt does not complete local generation.
- A still never satisfies a screen-recording shot.

## 6. Acceptance on the owner's computer (not yet done)

1. `sd-cli.exe -h` lists every flag in §1. Status shows `ready: true`.
2. Generate one still from a real shot prompt. The preview appears only after success. Watch progress and try Cancel once.
3. Approve, then bind to the shot. Reload the page: the bind survives.
4. Check the provenance shown matches the model hash in §2 and the seed you used.
5. Record the duration, RAM use and whether it stayed on CPU. Those numbers are the only performance evidence.

Until 1–5 are done on the owner's PC, local generation is **unproven**. Provider success, a fixture PNG, or a test double is not this.

## 7. Unverified and blocking items (named)

- Flag names against the installed `sd-cli.exe` build (§1).
- SD 1.5 weight SHA-256 (§2). Licence acceptance by the owner.
- Planner model choice and its licence (§3). No semantic output has been produced by a real local model.
- Vulkan probe (§4). CPU is the baseline.
- Owner-host runs of §6. Browser acceptance of the panel on the owner's machine.
