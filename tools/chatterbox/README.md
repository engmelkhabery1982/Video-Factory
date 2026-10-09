# Chatterbox voice-clone worker (optional, isolated)

Chatterbox is a **local voice-cloning TTS option** for this factory. It clones a
speaker from a short reference recording of that speaker's own voice. It is
**not** the default engine: Kokoro (and the SAM reference mode) keep working with
no Python, no GPU and no model download at all.

This directory holds the only part of the factory that runs Python:

| File | Purpose |
|---|---|
| `worker.py` | one-shot worker: reads a versioned JSON manifest on stdin, writes the raw 24 kHz WAV, answers with a versioned JSON response on stdout |
| `requirements.txt` | the pinned Python dependencies installed into the isolated env |

Everything the worker touches lives outside Git:

| Location | Contents | Committed? |
|---|---|---|
| `.chatterbox/env/` | isolated Python 3.11 virtual environment | never |
| `.chatterbox/models/` | model weights (HuggingFace cache layout) | never |
| `.chatterbox/scratch/` | raw engine output for one clip (deleted after normalization) | never |
| `.chatterbox/provisioned.json` | verified provisioning marker (what was actually installed + the resolved model revision) | never |
| `.voice-references/` | approved reference recordings of consenting speakers | never |

## Supported engine contracts

| Contract | Model repository | Size | Languages | Voice settings |
|---|---|---|---|---|
| `chatterbox-turbo` | `ResembleAI/chatterbox-turbo` | 350M | English only (`en`) | **not supported** — upstream ignores CFG/`min_p`/`exaggeration`, so declaring them is a hard error here |
| `chatterbox-multilingual-v3` | `ResembleAI/chatterbox` variant `v3` (`t3_mtl23ls_v3.safetensors`) | 500M | 23 ids: `ar da de el en es fi fr he hi it ja ko ms nl no pl pt ru sv sw tr zh` | `exaggeration` (default 0.5), `cfg_weight` (default 0.5), optional `min_p` |

Package pin: **`chatterbox-tts==0.1.7`** (MIT). Upstream facts recorded on
2026-10-08; see `DEPENDENCIES.md` for the full provenance and the known
limitation that upstream’s multilingual loader uses the floating `main`
revision — which is exactly why the **resolved commit** is recorded at
provisioning time and can never be invented.

Native output is **24 kHz mono**; the Node adapter normalizes every clip to the
factory’s canonical **48 kHz mono PCM16 WAV** with the existing ffmpeg
normalizer before it reaches the pipeline.

Every generated file carries Resemble AI’s **Perth (Perceptual Threshold) neural
watermark**. The worker imports the `perth` module and refuses to return audio
unless the loaded model has a watermarker. Library presence alone is not proof
that a particular file was watermarked. Device is a model-init argument.
`generate` is called with only the arguments that engine's signature accepts;
`device` is not passed to the upstream multilingual `generate`. The multilingual
contract loads variant `v3` explicitly from the cached revision. It does not
treat the upstream v2 default as v3, and the pinned `chatterbox-tts==0.1.7`
wheel cannot select `t3_model`. That pin is unchanged.

## Prerequisites

* Linux or macOS (Windows is untested for the isolated env).
* Python **3.11** on `PATH` (`python3.11 --version`).
* An NVIDIA GPU with a working CUDA driver for the default device policy.
  CPU synthesis is possible but is **not** verified by this repository: it must
  be approved explicitly (`device: 'cpu'`, `allowCpu: true`), and until then the
  adapter fails closed instead of running a slow unverified path.
* ≥ 12 GiB free disk space for the environment plus one model snapshot.

## Provisioning (explicit — never automatic)

```bash
npm run provision:voice-clone                      # check only: reports, changes nothing
npm run provision:voice-clone -- --check --json    # machine-readable check
npm run provision:voice-clone -- --apply           # the ONLY command that downloads
npm run provision:voice-clone -- --apply --engine=chatterbox-turbo
```

`npm install`, `npm ci`, `npm test`, `npm run build` and `npm start` never
download weights, never install Python packages and never run this worker.

`--apply` performs, in order: create the isolated venv → install the pinned
requirements → resolve the **real** upstream model revision → download the model
snapshot into `.chatterbox/models` → verify the import graph, torch/CUDA and the
Perth watermark → write `.chatterbox/provisioned.json` **last**. A marker
therefore always means “verified”, never “attempted”.

Synthesis itself is offline: the adapter verifies the marker (engine contract,
model id, package version, resolved revision) and the worker is started with
`HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1`. A missing or mismatched marker is
a blocking error with the remediation `npm run provision:voice-clone -- --apply`.

## Why cloning this voice is allowed: consent and documented rights

A cloned voice is a **commercial publication decision**, not a technical one.
Before a single sample is produced, the adapter re-runs the VS1 commercial
publication gate for the voice and refuses the job unless **all** of these hold:

* the voice profile declares a `cloned_reference_audio` acoustic source with a
  recorded Speaker consent (`ownerConfirmed: true`, non-revoked) whose scope
  includes commercial video publication and synthetic voice cloning;
* first-party **commercial-use rights evidence** exists. A licence that is
  *silent* about commercial use is **not** permission — `unknown` and
  `not_stated` block production;
* the audition was reviewed and approved by a named approver;
* the publication state is `approved`.

Then, per clip, the reference recording is re-hashed and must still match the
approved SHA-256. A recording that changed after review blocks synthesis.

## There is never a silent voice fallback

* An approved cloned voice is **never** silently replaced by Kokoro, by another
  Chatterbox contract/model, by a preset voice or by any default. Every mismatch
  is a blocking finding (`CHATTERBOX_VOICE_FALLBACK_BLOCKED`,
  `CHATTERBOX_MODEL_REVISION_MISMATCH`, `VOICE_PUBLICATION_BLOCKED`, …).
* A voice declaring a different engine family, model id, model revision or
  runtime version than the adapter would actually run is refused before any file
  is created.
* Kokoro remains available whenever it is explicitly selected — nothing about
  this feature changes Kokoro behaviour or its tests.

## Out of scope

Actor generation (synthesising a *different* person's likeness), lip-sync,
video rendering and anything beyond dialogue audio are out of scope for this
worker. It produces per-turn dialogue WAVs only.

## Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `CHATTERBOX_PYTHON_MISSING` | no usable Python 3.11 env | `npm run provision:voice-clone -- --apply` |
| `CHATTERBOX_MODEL_MISSING` | no verified marker / no snapshot | provision with `--apply` |
| `CHATTERBOX_MODEL_REVISION_MISMATCH` | marker, profile or adapter pin disagree | re-provision or re-review the voice against the provisioned revision |
| `CHATTERBOX_CUDA_REQUIRED` | no NVIDIA GPU (or CPU was not approved) | run on a CUDA host, or approve CPU explicitly after verifying it |
| `CHATTERBOX_CUDA_INIT_FAILED` | CUDA driver/runtime mismatch | align the driver with the provisioned torch build |
| `CHATTERBOX_GPU_OUT_OF_MEMORY` | GPU memory exhausted | free GPU memory or use `chatterbox-turbo` |
| `CHATTERBOX_WORKER_TIMEOUT` | bounded timeout exceeded | verify GPU availability; raise the timeout deliberately |
| `CHATTERBOX_REFERENCE_HASH_MISMATCH` | the recording changed after approval | re-hash, re-review and re-approve the voice |
| `CHATTERBOX_WATERMARK_MISSING` | Perth watermarker unavailable | re-provision so `resemble-perth` is present |

`npm run doctor` reports Chatterbox as an optional capability while it is
unselected and as blocking checks once it is selected
(`npm run doctor -- --require-chatterbox`). Doctor never downloads anything.
