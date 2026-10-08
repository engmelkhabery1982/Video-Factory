#!/usr/bin/env python3
"""DETERMINISTIC FAKE CHATTERBOX WORKER — test fixture only.

This file is the CI stand-in for `tools/chatterbox/worker.py`. It speaks the
exact same versioned JSON protocol (schema `chatterbox-worker-request/v1` ->
`chatterbox-worker-response/v1`) but it NEVER imports torch, never loads a model
and never touches the network. It exists so the Node adapter's process
handling, path safety, integrity checks and failure taxonomy can be tested with
real subprocess behaviour (real hang/kill, real non-zero exit, real stdout)
without a GPU or a single downloaded byte.

Behaviour is chosen by the environment variable FAKE_CHATTERBOX_MODE:

  ok            (default) write a deterministic non-silent 24 kHz WAV
  timeout                 sleep far longer than the adapter's bounded timeout
  nonzero                 exit with code 7 (stderr explains)
  invalid_json            print something that is not JSON
  bad_schema              answer with a foreign response schema
  bad_protocol            answer with protocolVersion 99
  empty                   create a 0-byte output and claim success
  silent                  write a valid WAV that contains only silence
  garbage_wav             write non-WAV bytes to the output path
  wrong_hash              claim a different sha256 than the file on disk
  no_watermark            answer ok with watermark.applied = false
  wrong_model             answer ok but report a different model/revision
  missing_output          answer ok without writing anything
  overflow                print more than the adapter's bounded stdout capture
  error:<CATEGORY>        structured error response (e.g. error:GPU_OUT_OF_MEMORY)

Every other validation mirrors the real worker: portable repo-relative paths
only, reference SHA-256 recomputed, contract/language/model checks. When the
mode is `ok` the worker also writes a RECEIPT next to the scratch output
(`<output>.receipt.json`) containing exactly what it received, so tests can
assert byte-exact text, language mapping, settings and engine identity without
adding any non-protocol field to the protocol itself.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import struct
import sys
import time
import wave

PROTOCOL_VERSION = 1
REQUEST_SCHEMA = "chatterbox-worker-request/v1"
RESPONSE_SCHEMA = "chatterbox-worker-response/v1"
NATIVE_SAMPLE_RATE = 24000

CONTRACTS = {
    "chatterbox-turbo": {
        "model_id": "ResembleAI/chatterbox-turbo",
        "languages": ("en",),
        "supports_settings": False,
    },
    "chatterbox-multilingual-v3": {
        "model_id": "ResembleAI/chatterbox",
        "languages": (
            "ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it",
            "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh",
        ),
        "supports_settings": True,
    },
}

MODE = os.environ.get("FAKE_CHATTERBOX_MODE", "ok")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(category: str, message: str) -> None:
    emit({
        "schema": RESPONSE_SCHEMA,
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "status": "error",
        "error": {"category": category, "message": message},
    })
    sys.exit(0)


def portable(value) -> bool:
    if not isinstance(value, str) or not value.strip():
        return False
    path = value.strip().replace("\\", "/")
    if path.startswith("/") or re.match(r"^[A-Za-z]:", path):
        return False
    return not any(seg in ("", ".", "..") for seg in path.split("/"))


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def sine_wav(path: str, frame_count: int) -> None:
    """Deterministic non-silent 440 Hz tone, mono PCM16 @ 24 kHz."""
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    amplitude = 0.35
    frames = bytearray()
    for index in range(frame_count):
        value = int(32767 * amplitude * __import__("math").sin(2 * 3.141592653589793 * 440 * index / NATIVE_SAMPLE_RATE))
        frames += struct.pack("<h", value)
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(NATIVE_SAMPLE_RATE)
        handle.writeframes(bytes(frames))


raw_request = sys.stdin.read()
request_id = "unknown"
try:
    request = json.loads(raw_request)
    request_id = str(request.get("requestId", "unknown"))
except Exception:  # noqa: BLE001
    fail("INTERNAL_ERROR", "manifest is not JSON")

if request.get("schema") != REQUEST_SCHEMA:
    fail("INTERNAL_ERROR", "unexpected request schema")
if request.get("protocolVersion") != PROTOCOL_VERSION:
    fail("INTERNAL_ERROR", "unexpected protocol version")
if MODE.startswith("error:"):
    fail(MODE.split(":", 1)[1] or "INTERNAL_ERROR", f"injected failure {MODE}")
if MODE == "nonzero":
    sys.stderr.write("fake worker crashing on purpose\n")
    sys.exit(7)
if MODE == "stderr_path":
    # Deliberately leaks absolute personal paths on stderr: the adapter must
    # sanitize them before they can reach a structured finding.
    sys.stderr.write("traceback: File \"/home/someone/private/voice.py\", line 1\n")
    sys.stderr.write("reading /home/someone/private/secret.wav failed\n")
    sys.exit(9)

contract_id = request.get("engineContractId")
contract = CONTRACTS.get(contract_id)
if contract is None:
    fail("INTERNAL_ERROR", "unknown engine contract")
if request.get("modelId") != contract["model_id"]:
    fail("MODEL_REVISION_MISMATCH", "manifest model does not match the contract")

language = str(request.get("languageId", "")).lower()
if language not in contract["languages"]:
    fail("UNSUPPORTED_LANGUAGE", f"language {language} unsupported")

reference = request.get("referenceAudio") or {}
if not portable(reference.get("path")):
    fail("INVALID_REFERENCE", "reference path is not portable")
reference_abs = os.path.join(os.getcwd(), reference["path"])
if not os.path.isfile(reference_abs):
    fail("INVALID_REFERENCE", "reference recording does not exist")
if sha256_file(reference_abs) != reference.get("sha256"):
    fail("INVALID_REFERENCE", "reference hash mismatch")

output = request.get("output") or {}
if not portable(output.get("path")):
    fail("OUTPUT_WRITE_FAILED", "output path is not portable")
if output.get("sampleRate") != NATIVE_SAMPLE_RATE or output.get("channels") != 1 or output.get("bitDepth") != 16:
    fail("OUTPUT_WRITE_FAILED", "output must be 24 kHz mono PCM16")

if MODE == "timeout":
    time.sleep(600)
    sys.exit(0)
if MODE == "invalid_json":
    sys.stdout.write("this is not json {")
    sys.stdout.flush()
    sys.exit(0)
if MODE == "bad_schema":
    emit({"schema": "chatterbox-worker-response/v0", "protocolVersion": PROTOCOL_VERSION,
          "requestId": request_id, "status": "ok"})
    sys.exit(0)
if MODE == "bad_protocol":
    emit({"schema": RESPONSE_SCHEMA, "protocolVersion": 99, "requestId": request_id, "status": "ok"})
    sys.exit(0)
if MODE == "overflow":
    sys.stdout.write("x" * (2 * 1024 * 1024))
    sys.stdout.flush()
    sys.exit(0)
if MODE == "missing_output":
    emit({
        "schema": RESPONSE_SCHEMA, "protocolVersion": PROTOCOL_VERSION, "requestId": request_id,
        "status": "ok",
        "engine": {"contractId": contract_id, "modelId": request["modelId"],
                   "modelRevision": request["modelRevision"], "packageVersion": "0.1.7",
                   "pythonVersion": "3.11-fake", "device": request.get("device", "cpu")},
        "watermark": {"provider": "resemble-perth", "applied": True},
        "audio": {"path": output["path"], "sampleRate": NATIVE_SAMPLE_RATE, "channels": 1,
                  "bitDepth": 16, "durationSeconds": 1.0, "frameCount": 24000,
                  "sha256": "0" * 64},
    })
    sys.exit(0)

output_abs = os.path.join(os.getcwd(), output["path"])
os.makedirs(os.path.dirname(output_abs) or ".", exist_ok=True)
text = str(request.get("text", ""))
frame_count = max(1200, min(24000 * 30, len(text) * 120))

if MODE == "empty":
    open(output_abs, "wb").close()
elif MODE == "garbage_wav":
    with open(output_abs, "wb") as handle:
        handle.write(b"NOT A WAV FILE" * 8)
elif MODE == "silent":
    with wave.open(output_abs, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(NATIVE_SAMPLE_RATE)
        handle.writeframes(b"\x00\x00" * frame_count)
else:
    sine_wav(output_abs, frame_count)

actual_sha = sha256_file(output_abs)
reported_sha = ("f" * 64) if MODE == "wrong_hash" else actual_sha
reported_contract = contract_id
reported_model = request["modelId"]
reported_revision = request["modelRevision"]
if MODE == "wrong_model":
    reported_model = "ResembleAI/chatterbox"
    reported_revision = "0" * 40

# A receipt lets the tests assert the EXACT request the adapter produced without
# adding any test-only field to the real protocol.
with open(f"{output_abs}.receipt.json", "w", encoding="utf8") as handle:
    json.dump({
        "requestId": request_id,
        "engineContractId": contract_id,
        "modelId": request["modelId"],
        "modelRevision": request["modelRevision"],
        "languageId": request.get("languageId"),
        "text": text,
        "settings": request.get("settings"),
        "settingsSupported": request.get("settingsSupported"),
        "referenceAudio": reference,
        "modelDir": request.get("modelDir"),
        "outputPath": output["path"],
        "device": request.get("device"),
        "pythonVersion": sys.version.split()[0],
        "mode": MODE,
    }, handle, ensure_ascii=False, indent=1)

emit({
    "schema": RESPONSE_SCHEMA,
    "protocolVersion": PROTOCOL_VERSION,
    "requestId": request_id,
    "status": "ok",
    "engine": {
        "contractId": reported_contract,
        "modelId": reported_model,
        "modelRevision": reported_revision,
        "packageVersion": "0.1.7",
        "pythonVersion": sys.version.split()[0],
        "device": request.get("device", "cpu"),
    },
    "watermark": {"provider": "resemble-perth", "applied": MODE != "no_watermark"},
    "settingsApplied": {
        "exaggeration": bool(contract["supports_settings"]),
        "cfgWeight": bool(contract["supports_settings"]),
        "minP": bool(contract["supports_settings"] and (request.get("settings") or {}).get("minP") is not None),
    },
    "audio": {
        "path": output["path"],
        "sampleRate": NATIVE_SAMPLE_RATE,
        "channels": 1,
        "bitDepth": 16,
        "durationSeconds": frame_count / NATIVE_SAMPLE_RATE,
        "frameCount": frame_count,
        "sha256": reported_sha,
    },
    "timings": {"loadMs": 1, "synthesizeMs": 1},
})
