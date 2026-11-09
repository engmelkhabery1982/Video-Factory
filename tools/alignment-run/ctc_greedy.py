"""Greedy CTC decoding from frame emissions.

Independent of any supplied script: the input is only the per-frame log
probabilities the model produced for THIS audio. Nothing here reads the
caption text, so the transcript can disagree with the script, and that
disagreement is the point of the comparison.

Pure standard library. No numpy and no torch are needed to test it.
"""
from __future__ import annotations

from typing import Callable, Sequence


def greedy_path(frames: Sequence[Sequence[float]], blank_id: int) -> list[int]:
    """Best token per frame (argmax), repeats collapsed, blanks removed."""
    path: list[int] = []
    previous: int | None = None
    for row in frames:
        best = 0
        best_value = row[0]
        for index, value in enumerate(row):
            if value > best_value:
                best_value = value
                best = index
        if best != previous and best != blank_id:
            path.append(best)
        previous = best
    return path


def decode_transcript(
    frames: Sequence[Sequence[float]],
    blank_id: int,
    decode_ids: Callable[[list[int]], str],
) -> dict:
    """Greedy transcript of one emission matrix. `decode_ids` maps token ids to text."""
    ids = greedy_path(frames, blank_id)
    text = decode_ids(ids) if ids else ""
    return {"text": " ".join(text.split()), "tokenCount": len(ids), "frames": len(frames)}


def transcript_provenance(
    *,
    audio_sha256: str,
    emissions_sha256: str,
    frames: int,
    blank_id: int,
    tokenizer_bytes: int,
    decoder: str,
) -> dict:
    """What the transcript came from. A consumer must refuse a transcript without this."""
    return {
        "method": "greedy_ctc",
        "source": "frame_emissions",
        "independentOfScript": True,
        "scriptCopied": False,
        "audioSha256": audio_sha256,
        "emissionsSha256": emissions_sha256,
        "frames": frames,
        "blankId": blank_id,
        "tokenizerBytes": tokenizer_bytes,
        "decoder": decoder,
        "fixture": False,
    }
