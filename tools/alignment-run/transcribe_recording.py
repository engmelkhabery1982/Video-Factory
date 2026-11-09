"""Script-free transcription of one audio file with the existing vf-align runtime (owner host, WSL).

Flags (the only inputs; there is NO script, caption, alignment target or text argument):
  --audio PATH        recording to transcribe (WAV, 24 kHz as the owner's recordings are)
  --out PATH          result JSON, written atomically; never inside the project data folder
  --checkpoint PATH   the checkpoint the runtime already has (integrity checked)
  --tokenizer PATH    the character tokenizer the runtime already has (size checked)
  --self-test         stdlib self-test of the chunk logic only; loads no model

Output (schemaVersion 2): transcript text decoded from THIS audio's greedy CTC path, the exact audio SHA-256, the
model identity, and emissions provenance. If the tokenizer decoder is unavailable the transcript is null with the
reason; nothing is copied from anywhere in its place.

Requires the owner runtime (torch 2.8.0+cpu, fairseq2, omnilingual_asr, numpy). It is not run in this sandbox.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from ctc_transcribe import greedy_over_audio, sha256_file_hex, transcript_from_ids  # noqa: E402

ENGINE = "omnilingual-asr 300m_v2 greedy CTC (vf-align runtime, script-free)"
ARCH = "300m_v2"
VOCAB = 10288


def blocker(message: str) -> None:
    raise SystemExit(f"BLOCKER={message}")


def write_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def run(args: argparse.Namespace) -> None:
    import align_recording as ar  # the existing runtime: model loading, tokenizer, forward pass

    audio = Path(args.audio)
    checkpoint = Path(args.checkpoint)
    tokenizer_path = Path(args.tokenizer)
    out = Path(args.out)
    if not audio.is_file():
        blocker("audio_missing")
    if checkpoint.stat().st_size != ar.CHECKPOINT_BYTES or checkpoint.read_bytes()[:2] != b"PK":
        blocker("checkpoint_integrity")
    if tokenizer_path.stat().st_size != ar.TOKENIZER_BYTES:
        blocker("tokenizer_size_mismatch")
    audio_sha = sha256_file_hex(str(audio))

    import numpy as np
    import torch

    model = ar.load_official_model(checkpoint)
    tokenizer, blank_id, _specials = ar.load_tokenizer(tokenizer_path)
    samples = ar.prepare_waveform(audio)
    total = int(samples.numel())

    def forward(start: int, end: int):
        local = ar.forward_log_probs(model, samples[start:end])
        ids = [int(i) for i in torch.argmax(local, dim=-1).tolist()]
        emission_bytes = local.detach().cpu().contiguous().numpy().astype(np.float32).tobytes()
        return ids, (end - start) / ar.SAMPLE_RATE / local.shape[0], emission_bytes

    stitched = greedy_over_audio(total, forward)

    decoder_name = "fairseq2-char:create_decoder"
    transcript = None
    unavailable = None
    try:
        decoder = tokenizer.create_decoder()

        def decode(ids):
            return str(decoder(torch.tensor(ids, dtype=torch.int64)))

        transcript = transcript_from_ids(stitched["ids"], blank_id, decode)["text"]
    except Exception as err:  # noqa: BLE001 - reported, never hidden
        unavailable = f"The character decoder is unavailable on this runtime ({type(err).__name__}). No transcript was produced, and no text was copied in its place."

    payload = {
        "schemaVersion": 2,
        "transcript": transcript,
        "transcriptUnavailable": unavailable,
        "audioSha256": audio_sha,
        "engine": ENGINE,
        "model": {
            "arch": ARCH,
            "vocab": VOCAB,
            "checkpointBytes": checkpoint.stat().st_size,
            "tokenizerBytes": tokenizer_path.stat().st_size,
            "officialWeightsUsed": True,
        },
        "provenance": {
            "method": "greedy_ctc",
            "source": "frame_emissions",
            "independentOfScript": True,
            "scriptCopied": False,
            "fixture": False,
            "emissionsSha256": stitched["emissionsSha256"],
            "frames": stitched["frames"],
            "frameSec": stitched["frameSec"],
            "blankId": int(blank_id),
            "decoder": decoder_name,
            "extraction": stitched["extraction"],
        },
    }
    write_atomic(out, payload)
    print(json.dumps({"out": str(out), "frames": stitched["frames"], "transcript": transcript is not None}, ensure_ascii=False))


def self_test() -> None:
    import unittest

    suite = unittest.defaultTestLoader.discover(str(HERE), pattern="test_transcribe_recording.py")
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    if not result.wasSuccessful():
        raise SystemExit("BLOCKER=self_test_failed")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--audio")
    parser.add_argument("--out")
    parser.add_argument("--checkpoint")
    parser.add_argument("--tokenizer")
    args = parser.parse_args()
    try:
        if args.self_test:
            self_test()
            return
        if not all((args.audio, args.out, args.checkpoint, args.tokenizer)):
            blocker("transcribe_arguments_missing")
        run(args)
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        blocker("transcription_exception")


if __name__ == "__main__":
    main()
