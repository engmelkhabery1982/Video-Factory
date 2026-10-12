"""Port of packages/core/src/scenario/ctc-alignment.ts.

Matching text is normalized here. Displayed Arabic is never rewritten.
This module does not read audio, estimate pauses, or write timings.
"""

from __future__ import annotations

import math
import unicodedata
from typing import Mapping, Sequence

NEG = float("-inf")
SUPPORT_MARGIN = 1.0


def round3(value: float) -> float:
    """Match JavaScript Math.round for non-negative times."""
    return math.floor(value * 1000.0 + 0.5) / 1000.0


def normalize_for_match(text: str) -> str:
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("\u0640", "")
    kept: list[str] = []
    for ch in text:
        category = unicodedata.category(ch)
        if ch.isspace() or category.startswith(("L", "N")):
            kept.append(ch)
        else:
            kept.append(" ")
    return " ".join("".join(kept).split())


def forced_align_ctc(
    log_probs: Sequence[Sequence[float]],
    token_ids: Sequence[int],
    blank_id: int,
    frame_sec: float,
) -> dict:
    frames = len(log_probs)
    count = len(token_ids)
    if not frame_sec > 0:
        return {"ok": False, "score": NEG, "spans": [], "reason": "The emission frame duration is unknown. No times were invented."}
    if frames == 0 or count == 0:
        return {"ok": False, "score": NEG, "spans": [], "reason": "There are no emissions or no known tokens to align."}
    if count > frames:
        return {"ok": False, "score": NEG, "spans": [], "reason": "The known text has more tokens than acoustic frames. It was not shortened to fit."}
    for token_id in token_ids:
        if not isinstance(token_id, int) or isinstance(token_id, bool) or token_id < 0 or token_id == blank_id:
            return {"ok": False, "score": NEG, "spans": [], "reason": "A known token is missing from the CTC vocabulary. Timing was not estimated from text length."}

    states = count * 2 + 1
    labels = [blank_id if state % 2 == 0 else token_ids[(state - 1) // 2] for state in range(states)]
    prev = [NEG] * states
    prev[0] = _at(log_probs, 0, labels[0])
    if states > 1:
        prev[1] = _at(log_probs, 0, labels[1])
    back = [[-1] * states for _ in range(frames)]

    for time in range(1, frames):
        nxt = [NEG] * states
        for state in range(states):
            best = prev[state]
            origin = state
            if state > 0 and prev[state - 1] > best:
                best = prev[state - 1]
                origin = state - 1
            if state % 2 == 1 and state > 1 and labels[state] != labels[state - 2] and prev[state - 2] > best:
                best = prev[state - 2]
                origin = state - 2
            emit = _at(log_probs, time, labels[state])
            if best == NEG or not math.isfinite(emit):
                continue
            nxt[state] = best + emit
            back[time][state] = origin
        prev = nxt

    end_state = states - 1
    if states > 1 and prev[states - 2] > prev[end_state]:
        end_state = states - 2
    if prev[end_state] == NEG:
        return {"ok": False, "score": NEG, "spans": [], "reason": "No CTC path covers the known text. Pause timing was not used instead."}

    state_at = [0] * frames
    state_at[-1] = end_state
    for time in range(frames - 1, 0, -1):
        origin = back[time][state_at[time]]
        if origin < 0:
            return {"ok": False, "score": prev[end_state], "spans": [], "reason": "The CTC path could not be traced. No times were saved."}
        state_at[time - 1] = origin

    spans = [
        {"tokenId": token_id, "startFrame": -1, "endFrame": -1, "start": 0.0, "end": 0.0, "supported": False}
        for token_id in token_ids
    ]
    for time, state in enumerate(state_at):
        if state % 2 == 0:
            continue
        span = spans[(state - 1) // 2]
        if span["startFrame"] < 0:
            span["startFrame"] = time
        span["endFrame"] = time + 1

    for span in spans:
        if span["startFrame"] < 0 or span["endFrame"] <= span["startFrame"]:
            return {"ok": False, "score": prev[end_state], "spans": [], "reason": "A known token received no acoustic frame. Its time was not guessed."}
        span["start"] = round3(span["startFrame"] * frame_sec)
        span["end"] = round3(span["endFrame"] * frame_sec)
        span["supported"] = False
        for time in range(span["startFrame"], span["endFrame"]):
            token = _at(log_probs, time, span["tokenId"])
            blank = _at(log_probs, time, blank_id)
            if token + SUPPORT_MARGIN >= blank:
                span["supported"] = True
    if any(not span["supported"] for span in spans):
        return {
            "ok": False,
            "score": prev[end_state],
            "spans": [],
            "reason": "A known token was placed where the blank is more likely. That time was not kept, and pause timing was not used.",
        }
    return {"ok": True, "score": prev[end_state], "spans": spans, "reason": ""}


def words_from_token_spans(original_words: Sequence[str], spans: Sequence[Mapping], space_id: int) -> list[dict]:
    words: list[dict] = []
    cursor = 0
    for text in original_words:
        letters = len(normalize_for_match(text).replace(" ", ""))
        owned: list[Mapping] = []
        while cursor < len(spans) and spans[cursor]["tokenId"] == space_id:
            cursor += 1
        for _ in range(letters):
            if cursor >= len(spans):
                break
            owned.append(spans[cursor])
            cursor += 1
        if len(owned) != letters or not owned:
            words.append({"text": text, "start": 0.0, "end": 0.0, "supported": False})
            continue
        words.append({
            "text": text,
            "start": owned[0]["start"],
            "end": owned[-1]["end"],
            "supported": all(span["supported"] for span in owned),
        })
    return words


def proposal_from_aligned_words(
    audio_duration_sec: float,
    units: Sequence[Mapping],
    words_by_scene: Mapping[str, Sequence[Mapping]],
    unresolved: Sequence[Mapping] | None = None,
) -> dict:
    pending = [dict(item) for item in (unresolved or ())]
    placed: list[dict] = []
    for unit in units:
        words = list(words_by_scene.get(unit["sceneId"], ()))
        expected = [part for part in str(unit["text"]).strip().split() if part]
        if len(words) != len(expected) or any(not word["supported"] or not word["end"] > word["start"] for word in words):
            pending.append({
                "sceneId": unit["sceneId"],
                "text": unit["text"],
                "reason": "One or more words have no supported acoustic span. Their time was not taken from text length or pauses.",
            })
            continue
        placed.append({"unit": unit, "start": words[0]["start"], "speechEnd": words[-1]["end"]})
    if pending or len(placed) != len(units):
        return unavailable_proposal(
            "CTC alignment did not place every known sentence. Saved timings were not replaced, and pause estimation was not used.",
            pending,
        )
    starts = [0.0 if index == 0 else round3(row["start"]) for index, row in enumerate(placed)]
    for index in range(1, len(starts)):
        if starts[index] <= starts[index - 1]:
            return unavailable_proposal(
                f"The aligned start of {placed[index]['unit']['sceneId']} does not follow {placed[index - 1]['unit']['sceneId']}. Nothing was saved.",
                pending,
            )
    if starts[-1] >= audio_duration_sec:
        return unavailable_proposal("The last aligned sentence starts at or after the end of the recording. Nothing was saved.", pending)
    rows = []
    for index, row in enumerate(placed):
        scene_start = starts[index]
        next_start = audio_duration_sec if index == len(placed) - 1 else starts[index + 1]
        caption_start = round3(max(scene_start, row["start"])) if index == 0 else scene_start
        caption_end = round3(min(next_start, max(caption_start + 0.001, row["speechEnd"])))
        rows.append({
            "sceneId": row["unit"]["sceneId"],
            "cueId": row["unit"].get("cueId"),
            "text": row["unit"]["text"],
            "userEdited": row["unit"].get("userEdited") is True,
            "proposedStart": scene_start,
            "proposedDurationSec": round3(next_start - scene_start),
            "proposedCaptionStart": caption_start,
            "proposedCaptionEnd": caption_end,
            "warnings": [],
        })
    return {
        "available": True,
        "method": "ctc_forced",
        "sourceLabel": "CTC word alignment",
        "detail": "Sentence times come from one CTC forced alignment of the known text to frame emissions. A transcript without those emissions is not timing. This is not a listening approval.",
        "acousticVerification": False,
        "verified": False,
        "rows": rows,
        "warnings": [],
        "unresolved": pending,
        "saved": False,
    }


def unavailable_proposal(detail: str, unresolved: Sequence[Mapping] | None = None) -> dict:
    return {
        "available": False,
        "method": "unavailable",
        "sourceLabel": "Alignment unavailable",
        "detail": detail,
        "acousticVerification": False,
        "verified": False,
        "rows": [],
        "warnings": [detail],
        "unresolved": [dict(item) for item in (unresolved or ())],
        "saved": False,
    }


def _at(log_probs: Sequence[Sequence[float]], time: int, token_id: int) -> float:
    row = log_probs[time]
    if token_id < 0 or token_id >= len(row):
        return NEG
    value = row[token_id]
    return value if isinstance(value, (int, float)) and math.isfinite(value) else NEG
