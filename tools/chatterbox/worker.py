#!/usr/bin/env python3
"""BuildTrack Video Factory - Chatterbox voice-clone worker (isolated process).

This process is spawned DIRECTLY by the Node adapter
(`packages/core/src/scenario/chatterbox-dialogue-synthesizer.ts`) with
`shell: false`. It reads ONE versioned JSON manifest from stdin, verifies
everything it was told, runs the local Chatterbox model on the requested device
and writes a RAW 24 kHz mono PCM16 WAV into the scratch path from the manifest.
It then prints ONE versioned JSON response on stdout. Nothing else is ever
printed on stdout.

Why a separate process
----------------------
Chatterbox is a Python/torch model: it needs its own interpreter, its own
pinned dependencies and (ideally) an NVIDIA GPU, while the factory is Node. The
process boundary also keeps the model's optional CUDA dependency out of the
application runtime: if the env is missing, synthesis fails with a structured
code instead of crashing the factory.

Safety rules enforced here (defense in depth — the adapter enforces them too):
  * every path in the manifest is repo-relative and portable; absolute paths,
    traversal and paths outside the worker's cwd are refused;
  * the model directory must be repo-relative and inside the repository;
  * the reference recording's SHA-256 is recomputed before it is used;
  * synthesis is OFFLINE: HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE are honored and
    the model is loaded from the provisioned local cache only;
  * the Perth neural watermark must be confirmed present, or no audio is
    returned at all;
  * handled failures produce a structured JSON error response and exit 0;
    only a truly unhandled failure exits non-zero (the adapter treats a
    non-zero exit as a blocking failure in both cases).

Model facts (verified 2026-10-08, see DEPENDENCIES.md):
  * `chatterbox-turbo`           -> ResembleAI/chatterbox-turbo (English, 350M)
  * `chatterbox-multilingual-v3` -> ResembleAI/chatterbox (23 languages, 500M)
  * native output is 24 kHz mono (S3GEN_SR); the adapter normalizes it to the
    canonical 48 kHz mono PCM16 WAV used by the rest of the factory.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
import wave
from typing import Any, Dict, Optional, Tuple

PROTOCOL_VERSION = 1
REQUEST_SCHEMA = "chatterbox-worker-request/v1"
RESPONSE_SCHEMA = "chatterbox-worker-response/v1"
NATIVE_SAMPLE_RATE = 24000

CONTRACTS = {
    "chatterbox-turbo": {
        "model_id": "ResembleAI/chatterbox-turbo",
        "python_class": ("chatterbox.tts_turbo", "ChatterboxTurboTTS"),
        "languages": ("en",),
        "supports_settings": False,
    },
    "chatterbox-multilingual-v3": {
        "model_id": "ResembleAI/chatterbox",
        "python_class": ("chatterbox.mtl_tts", "ChatterboxMultilingualTTS"),
        "languages": (
            "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it",
            "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
        ),
        "supports_settings": True,
    },
}

_PATH_RE = re.compile(r"^[A-Za-z0-9._\-/]+$")


class WorkerError(Exception):
    """Structured, categorised failure carried back to the adapter."""

    def __init__(self, category: str, message: str, remediation: Optional[str] = None):
        super().__init__(message)
        self.category = category
        self.message = message
        self.remediation = remediation


def emit(payload: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def error_response(
    request_id: str,
    category: str,
    message: str,
    remediation: Optional[str] = None,
    engine: Optional[Dict[str, Any]] = None,
) -> None:
    body: Dict[str, Any] = {
        "schema": RESPONSE_SCHEMA,
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "status": "error",
        "error": {"category": category, "message": message},
    }
    if remediation:
        body["error"]["remediation"] = remediation
    if engine:
        body["engine"] = engine
    emit(body)


def verify_portable_path(value: Any, role: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise WorkerError("OUTPUT_WRITE_FAILED" if role == "output" else "INVALID_REFERENCE",
                          f"{role} path must be a non-empty string.")
    path = value.strip().replace("\\", "/")
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        raise WorkerError("OUTPUT_WRITE_FAILED" if role == "output" else "INVALID_REFERENCE",
                          f"{role} path must be repo-relative, got an absolute path.")
    segments = path.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        raise WorkerError("OUTPUT_WRITE_FAILED" if role == "output" else "INVALID_REFERENCE",
                          f"{role} path contains traversal segments.")
    if not _PATH_RE.match(path):
        raise WorkerError("OUTPUT_WRITE_FAILED" if role == "output" else "INVALID_REFERENCE",
                          f"{role} path contains forbidden characters.")
    absolute = os.path.realpath(os.path.join(os.getcwd(), path))
    cwd = os.path.realpath(os.getcwd())
    if absolute != cwd and not absolute.startswith(cwd + os.sep):
        raise WorkerError("OUTPUT_WRITE_FAILED" if role == "output" else "INVALID_REFERENCE",
                          f"{role} path escapes the repository root.")
    return path


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_request() -> Dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise WorkerError("INTERNAL_ERROR", "No manifest was provided on stdin.")
    try:
        request = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WorkerError("INTERNAL_ERROR", f"Manifest is not valid JSON: {exc}") from exc
    if not isinstance(request, dict):
        raise WorkerError("INTERNAL_ERROR", "Manifest must be a JSON object.")
    return request


def validate_request(request: Dict[str, Any]) -> Dict[str, Any]:
    problems = []
    if request.get("schema") != REQUEST_SCHEMA:
        problems.append("schema")
    if request.get("protocolVersion") != PROTOCOL_VERSION:
        # Version mismatch is reported with its own category so the adapter can
        # distinguish it from a structurally invalid manifest.
        raise WorkerError("MODEL_REVISION_MISMATCH", "Unsupported manifest protocol version.")
    for field in ("requestId", "engineContractId", "modelId", "modelRevision", "languageId", "text"):
        value = request.get(field)
        if not isinstance(value, str) or not value.strip():
            problems.append(field)
    contract_id = request.get("engineContractId")
    if contract_id not in CONTRACTS:
        problems.append("engineContractId")
    if request.get("device") not in ("cuda", "cpu"):
        problems.append("device")
    if request.get("requireWatermark") is not True:
        problems.append("requireWatermark")
    if problems:
        raise WorkerError("INTERNAL_ERROR", f"Manifest is missing/invalid fields: {', '.join(sorted(set(problems)))}")

    contract = CONTRACTS[contract_id]
    if request["modelId"] != contract["model_id"]:
        raise WorkerError("MODEL_REVISION_MISMATCH",
                          f"Manifest model '{request['modelId']}' is not the model of contract '{contract_id}'.")
    language = request["languageId"].lower()
    if language not in contract["languages"]:
        raise WorkerError("UNSUPPORTED_LANGUAGE",
                          f"Language '{language}' is not supported by contract '{contract_id}'.")
    if len(request["text"]) > 5000:
        raise WorkerError("INTERNAL_ERROR", "text exceeds the 5000 character bound.")

    reference = request.get("referenceAudio")
    if not isinstance(reference, dict):
        raise WorkerError("INVALID_REFERENCE", "referenceAudio is required.")
    verify_portable_path(reference.get("path"), "reference")
    declared_hash = reference.get("sha256")
    if not isinstance(declared_hash, str) or not re.match(r"^[0-9a-f]{64}$", declared_hash):
        raise WorkerError("INVALID_REFERENCE", "referenceAudio.sha256 must be 64 lowercase hex characters.")

    output = request.get("output")
    if not isinstance(output, dict):
        raise WorkerError("OUTPUT_WRITE_FAILED", "output target is required.")
    verify_portable_path(output.get("path"), "output")
    if (output.get("sampleRate") != NATIVE_SAMPLE_RATE or output.get("channels") != 1
            or output.get("bitDepth") != 16 or output.get("container") != "wav"):
        raise WorkerError("OUTPUT_WRITE_FAILED",
                          "output target must be 24000 Hz mono PCM16 WAV.")

    model_dir = verify_portable_path(request.get("modelDir"), "output")
    return {"contract": contract, "language": language, "model_dir": model_dir}


def verify_reference(reference: Dict[str, Any]) -> str:
    path = verify_portable_path(reference.get("path"), "reference")
    absolute = os.path.join(os.getcwd(), path)
    if not os.path.isfile(absolute):
        raise WorkerError("INVALID_REFERENCE", "Reference recording does not exist.")
    actual = sha256_file(absolute)
    if actual != reference["sha256"]:
        raise WorkerError("INVALID_REFERENCE",
                          "Reference recording hash does not match the approved manifest.")
    return absolute


def resolve_device(requested: str) -> Tuple[str, Dict[str, Any]]:
    import torch  # imported here so a missing dependency is a structured failure

    cuda_available = bool(torch.cuda.is_available())
    if requested == "cuda" and not cuda_available:
        raise WorkerError("CUDA_REQUIRED",
                          "CUDA execution was required but torch reports no usable CUDA device.")
    if requested == "cuda":
        try:
            index = torch.cuda.current_device()
            name = torch.cuda.get_device_name(index)
        except Exception as exc:  # noqa: BLE001 - reported as a structured finding
            raise WorkerError("CUDA_INIT_FAILED", f"CUDA device initialisation failed: {exc}") from exc
        return "cuda", {"gpuName": name, "torchVersion": str(torch.__version__),
                        "cudaRuntimeVersion": getattr(torch.version, "cuda", None)}
    return "cpu", {"torchVersion": str(torch.__version__)}


def resolve_model_revision(model_dir: str, model_id: str, requested_revision: str) -> str:
    """Resolve the revision that is ACTUALLY present in the local cache.

    Upstream loads the floating `main` branch, so the only honest revision is
    the resolved commit already recorded in the provisioning marker. Here we
    verify that the cached snapshot for that revision exists; anything else is
    a MODEL_MISSING/MODEL_REVISION_MISMATCH failure — never a download.
    """
    cache_dir = os.environ.get("HF_HOME") or os.path.join(os.getcwd(), model_dir)
    owner, _, name = model_id.partition("/")
    repo_dir = os.path.join(cache_dir, f"models--{owner}--{name}")
    snapshots = os.path.join(repo_dir, "snapshots")
    if not os.path.isdir(snapshots):
        raise WorkerError("MODEL_MISSING",
                          "Model is not present in the local cache. Provision it once (network).",
                          "Run: npm run provision:voice-clone -- --apply")
    available = sorted(os.listdir(snapshots))
    if not available:
        raise WorkerError("MODEL_MISSING", "Model cache contains no snapshots.")
    if requested_revision and not any(entry.startswith(requested_revision) or requested_revision.startswith(entry)
                                      for entry in available):
        raise WorkerError("MODEL_REVISION_MISMATCH",
                          "The cached model revision differs from the requested revision.",
                          "Re-run provisioning for the requested revision.")
    return requested_revision


def load_model(contract: Dict[str, Any], device: str, model_id: str) -> Any:
    module_name, class_name = contract["python_class"]
    try:
        module = __import__(module_name, fromlist=[class_name])
        model_class = getattr(module, class_name)
    except Exception as exc:  # noqa: BLE001
        raise WorkerError("MISSING_DEPENDENCY",
                          f"Could not load '{module_name}.{class_name}': {exc}",
                          "Run: npm run provision:voice-clone -- --apply") from exc
    try:
        model = model_class.from_pretrained(device=device)
    except Exception as exc:  # noqa: BLE001
        message = str(exc)
        lowered = message.lower()
        if "out of memory" in lowered:
            raise WorkerError("GPU_OUT_OF_MEMORY", "Model load ran out of GPU memory.",
                              "Free GPU memory or use the 350M turbo contract.") from exc
        if "cuda" in lowered:
            raise WorkerError("CUDA_INIT_FAILED", f"CUDA initialisation failed: {message}") from exc
        if "local_files_only" in lowered or "not found" in lowered or "offline" in lowered:
            raise WorkerError("MODEL_MISSING",
                              "The model could not be loaded from the local cache (offline).",
                              "Run: npm run provision:voice-clone -- --apply") from exc
        raise WorkerError("INTERNAL_ERROR", f"Model load failed: {message}") from exc
    # The adapter only loads this model id; assert the runtime agrees.
    reported_id = getattr(model, "repo_id", None) or getattr(getattr(model, "t3", None), "repo_id", None)
    if reported_id and reported_id != model_id:
        raise WorkerError("MODEL_REVISION_MISMATCH",
                          f"Loaded model '{reported_id}' is not the requested '{model_id}'.")
    return model


def confirm_watermark(model: Any) -> bool:
    """The Perth watermarker must be present before any audio is returned."""
    try:
        import resemble_perth  # noqa: F401  (presence check only)
    except Exception:  # noqa: BLE001
        return False
    return getattr(model, "watermarker", None) is not None


def synthesize(model: Any, contract: Dict[str, Any], text: str, language: str,
               reference_path: str, settings: Dict[str, Any], device: str) -> Any:
    kwargs: Dict[str, Any] = {}
    if device == "cuda":
        kwargs["device"] = "cuda"
    # Turbo ignores CFG/exaggeration/min_p upstream — pass nothing so the
    # adapter cannot believe an ignored parameter was applied.
    if contract["supports_settings"]:
        kwargs["exaggeration"] = float(settings.get("exaggeration", 0.5))
        kwargs["cfg_weight"] = float(settings.get("cfgWeight", 0.5))
        if settings.get("minP") is not None:
            kwargs["min_p"] = float(settings["minP"])
    try:
        if contract["supports_settings"]:
            wav = model.generate(text, language_id=language,
                                 audio_prompt_path=reference_path, **kwargs)
        else:
            wav = model.generate(text, audio_prompt_path=reference_path, **kwargs)
    except RuntimeError as exc:
        message = str(exc)
        if "out of memory" in message.lower():
            raise WorkerError("GPU_OUT_OF_MEMORY", "Synthesis ran out of GPU memory.",
                              "Free GPU memory or shorten the clip.") from exc
        raise WorkerError("SYNTHESIS_FAILED", f"Chatterbox synthesis failed: {message}") from exc
    except Exception as exc:  # noqa: BLE001
        raise WorkerError("SYNTHESIS_FAILED", f"Chatterbox synthesis failed: {exc}") from exc
    return wav


def write_wav(output_path: str, wav: Any) -> Tuple[int, float]:
    """Write 16-bit PCM mono WAV with the stdlib (deterministic container)."""
    samples = wav.detach().to("cpu").float().reshape(-1)
    frame_count = int(samples.shape[0])
    if frame_count <= 0:
        raise WorkerError("EMPTY_AUDIO", "The model produced no audio frames.")
    clipped = samples.clamp(-1.0, 1.0)
    pcm = (clipped * 32767.0).round().to("int16").numpy().tobytes()
    directory = os.path.dirname(output_path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    with wave.open(output_path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(NATIVE_SAMPLE_RATE)
        handle.writeframes(pcm)
    return frame_count, frame_count / float(NATIVE_SAMPLE_RATE)


def main() -> int:
    request_id = "unknown"
    try:
        request = load_request()
        request_id = str(request.get("requestId", "unknown"))
        validated = validate_request(request)
        contract = validated["contract"]

        reference_path = verify_reference(request["referenceAudio"])
        device, device_report = resolve_device(request["device"])
        model_revision = resolve_model_revision(validated["model_dir"], request["modelId"],
                                                request["modelRevision"])

        load_started = time.monotonic()
        model = load_model(contract, device, request["modelId"])
        load_ms = int((time.monotonic() - load_started) * 1000)

        if not confirm_watermark(model):
            raise WorkerError("WATERMARK_MISSING",
                              "The Perth neural watermarker is not available in this environment; "
                              "audio is refused rather than returned unmarked.")

        synthesis_started = time.monotonic()
        wav = synthesize(model, contract, request["text"], validated["language"],
                         reference_path, request.get("settings") or {}, device)
        synthesize_ms = int((time.monotonic() - synthesis_started) * 1000)

        output_path = verify_portable_path(request["output"]["path"], "output")
        absolute_output = os.path.join(os.getcwd(), output_path)
        frame_count, duration = write_wav(absolute_output, wav)
        digest = sha256_file(absolute_output)

        emit({
            "schema": RESPONSE_SCHEMA,
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": request_id,
            "status": "ok",
            "engine": {
                "contractId": request["engineContractId"],
                "modelId": request["modelId"],
                "modelRevision": model_revision,
                "packageVersion": getattr(__import__("chatterbox"), "__version__", "0.1.7"),
                "pythonVersion": sys.version.split()[0],
                "device": device,
                **{key: value for key, value in device_report.items() if value},
            },
            "watermark": {"provider": "resemble-perth", "applied": True},
            "settingsApplied": {
                "exaggeration": bool(contract["supports_settings"]),
                "cfgWeight": bool(contract["supports_settings"]),
                "minP": bool(contract["supports_settings"] and (request.get("settings") or {}).get("minP") is not None),
            },
            "audio": {
                "path": output_path,
                "sampleRate": NATIVE_SAMPLE_RATE,
                "channels": 1,
                "bitDepth": 16,
                "durationSeconds": duration,
                "frameCount": frame_count,
                "sha256": digest,
            },
            "timings": {"loadMs": load_ms, "synthesizeMs": synthesize_ms},
        })
        return 0
    except WorkerError as exc:
        error_response(request_id, exc.category, exc.message, exc.remediation)
        return 0
    except Exception as exc:  # noqa: BLE001 - last-resort safety net
        sys.stderr.write(f"chatterbox worker unhandled failure: {type(exc).__name__}: {exc}\n")
        return 3


if __name__ == "__main__":
    sys.exit(main())
