"""Script-free greedy CTC transcription: pure logic (stdlib only).

Input is audio. There is NO script, caption, alignment target or forced text anywhere in this module. The
output is the greedy CTC path of this audio's own frame emissions, collapsed and with blanks removed.

Memory: each chunk is reduced to per-frame argmax ids and a streamed SHA-256 of its float32 emission bytes. The
full emission matrix is never held, so a long recording does not need memory proportional to frames x vocab.

Chunking (used only when the full forward raises, the same trigger as the forced-alignment extractor):
  - chunk 20 s, overlap 4 s, and 2 s discarded at every interior edge. The first chunk keeps its start and the
    last keeps its end. Each kept span starts exactly where the previous one ends (checked).
  - Stitching concatenates per-frame argmax ids of the KEPT frames, then collapses repeats and blanks ONCE over the
    whole sequence. Per-frame argmax does not depend on other frames, so this equals the greedy path over the
    kept frames. Only the model's context at chunk edges can differ, which is why 2 s is discarded there.
  - No sentence boundary is inserted or inferred. Text comes only from token ids.
"""
from __future__ import annotations

import hashlib
from typing import Callable, Sequence

SAMPLE_RATE = 16000
CHUNK_SEC = 20
OVERLAP_SEC = 4
DROP_SEC = 2
FRAME_TOLERANCE_SEC = 0.001
CONTIGUITY_TOLERANCE = 1.5  # in frames


def collapse_ids(ids: Sequence[int], blank_id: int) -> list[int]:
    """Greedy CTC collapse of a per-frame argmax sequence: repeats merged, blanks removed."""
    path: list[int] = []
    previous: int | None = None
    for best in ids:
        if best != previous and best != blank_id:
            path.append(int(best))
        previous = best
    return path


ForwardRange = Callable[[int, int], tuple[list[int], float, bytes]]
"""forward(start_sample, end_sample) -> (argmax ids per frame, seconds per frame, float32 emission bytes)."""


def stream_chunked(total: int, forward: ForwardRange, *, sr: int = SAMPLE_RATE,
                   chunk_sec: int = CHUNK_SEC, overlap_sec: int = OVERLAP_SEC, drop_sec: int = DROP_SEC) -> dict:
    """Run the chunk plan and stitch the kept frames. Raises ValueError on any inconsistency; nothing is repaired."""
    if total <= 0:
        raise ValueError("no audio samples")
    chunk = chunk_sec * sr
    overlap = overlap_sec * sr
    drop = drop_sec * sr
    kept_ids: list[int] = []
    digest = hashlib.sha256()
    frame_secs: list[float] = []
    previous_end: float | None = None
    frames_total = 0
    chunks = 0
    start = 0
    while start < total:
        end = min(total, start + chunk)
        ids, local_sec, emission_bytes = forward(start, end)
        if not ids:
            raise ValueError("a chunk produced no frames")
        frame_secs.append(local_sec)
        left = 0 if start == 0 else int(round(drop / sr / local_sec))
        right = 0 if end == total else int(round(drop / sr / local_sec))
        stop = len(ids) - right if right else len(ids)
        if stop <= left:
            raise ValueError("chunk stitch removed every frame")
        origin = start / sr + left * local_sec
        if previous_end is not None and abs(origin - previous_end) > local_sec * CONTIGUITY_TOLERANCE:
            raise ValueError("chunk stitch is not contiguous")
        kept_ids.extend(ids[left:stop])
        # The emission digest covers the kept frames only, in order. Its bytes are provided per chunk by the caller.
        frame_bytes = len(emission_bytes) // len(ids) if ids else 0
        digest.update(emission_bytes[left * frame_bytes: stop * frame_bytes])
        previous_end = origin + (stop - left) * local_sec
        frames_total += stop - left
        chunks += 1
        if end == total:
            break
        start = end - overlap
    if max(frame_secs) - min(frame_secs) > FRAME_TOLERANCE_SEC:
        raise ValueError("chunk frame durations differ")
    return {
        "ids": kept_ids,
        "frames": frames_total,
        "frameSec": frame_secs[0],
        "emissionsSha256": digest.hexdigest(),
        "extraction": {
            "mode": "chunked_forward",
            "chunks": chunks,
            "chunkSec": chunk_sec,
            "overlapSec": overlap_sec,
            "edgeDiscardSec": drop_sec,
            "transcribeCalled": False,
        },
    }


def greedy_over_audio(total: int, forward: ForwardRange, *, full_error_types: tuple = (RuntimeError, MemoryError)) -> dict:
    """One full forward when possible; the chunk plan when the full forward raises one of `full_error_types`."""
    try:
        ids, frame_sec, emission_bytes = forward(0, total)
        if not ids:
            raise ValueError("the full forward produced no frames")
        return {
            "ids": list(ids),
            "frames": len(ids),
            "frameSec": frame_sec,
            "emissionsSha256": hashlib.sha256(emission_bytes).hexdigest(),
            "extraction": {"mode": "full_forward", "frames": len(ids), "transcribeCalled": False},
        }
    except full_error_types as exc:
        failure = str(exc)
    result = stream_chunked(total, forward)
    result["extraction"]["fullForwardError"] = failure
    return result


def transcript_from_ids(ids: Sequence[int], blank_id: int, decode: Callable[[list[int]], str]) -> dict:
    """Collapse, then decode. The text is whatever the tokenizer decodes from these ids."""
    path = collapse_ids(ids, blank_id)
    text = decode(path) if path else ""
    return {"text": " ".join(text.split()), "tokenCount": len(path)}


def sha256_file_hex(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()
