"""Compare this port with the TypeScript aligner. Not a recording test."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from ctc_forced import forced_align_ctc, normalize_for_match, proposal_from_aligned_words, words_from_token_spans
NODE = r"""
import { forcedAlignCtc, normalizeForMatch, proposalFromAlignedWords, wordsFromTokenSpans } from './packages/core/dist/scenario/ctc-alignment.js';
const input = JSON.parse(process.argv[1]);
const aligned = forcedAlignCtc(input.logProbs, input.tokenIds, input.blankId, input.frameSec);
const words = aligned.ok ? wordsFromTokenSpans(input.words, aligned.spans, input.spaceId) : [];
const proposal = proposalFromAlignedWords({
  audioDurationSec: input.audioDurationSec,
  units: input.units,
  wordsByScene: new Map(input.units.map((unit) => [unit.sceneId, words])),
});
process.stdout.write(JSON.stringify({
  normalized: normalizeForMatch(input.display),
  ok: aligned.ok,
  reason: aligned.reason,
  spans: aligned.spans,
  words,
  proposal,
}));
"""


def peaked(frames: int, vocab: int, peaks: list[tuple[int, int]]) -> list[list[float]]:
    rows = [[-8.0] * vocab for _ in range(frames)]
    for row in rows:
        row[0] = -0.1
    for frame, token_id in peaks:
        rows[frame] = [-12.0] * vocab
        rows[frame][0] = -10.0
        rows[frame][token_id] = -0.01
    return rows


def compare(case: dict) -> None:
    local_norm = normalize_for_match(case["display"])
    aligned = forced_align_ctc(case["logProbs"], case["tokenIds"], case["blankId"], case["frameSec"])
    words = words_from_token_spans(case["words"], aligned["spans"], case["spaceId"]) if aligned["ok"] else []
    proposal = proposal_from_aligned_words(case["audioDurationSec"], case["units"], {case["units"][0]["sceneId"]: words})
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", NODE, json.dumps(case)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    remote = json.loads(completed.stdout)
    if remote["normalized"] != local_norm:
        raise SystemExit(f"normalization mismatch: {local_norm!r} != {remote['normalized']!r}")
    if remote["ok"] != aligned["ok"] or remote["reason"] != aligned["reason"]:
        raise SystemExit(f"alignment mismatch: {aligned} != {remote}")
    if remote["spans"] != aligned["spans"] or remote["words"] != words:
        raise SystemExit(f"span mismatch:\nlocal={aligned['spans']}\nnode={remote['spans']}\nwords={words}\nnodeWords={remote['words']}")
    if remote["proposal"]["available"] != proposal["available"] or remote["proposal"]["rows"] != proposal["rows"]:
        raise SystemExit(f"proposal mismatch:\n{proposal}\n{remote['proposal']}")


def main() -> None:
    display = "تَنْظُرُ إلى"
    token_ids = [2, 3, 4, 5, 1, 6, 7, 8]
    peaks = [(4 + index * 2, token_id) for index, token_id in enumerate(token_ids)]
    compare({
        "display": display,
        "logProbs": peaked(30, 12, peaks),
        "tokenIds": token_ids,
        "blankId": 0,
        "spaceId": 1,
        "frameSec": 0.02,
        "audioDurationSec": 1.5,
        "words": [display],
        "units": [{"sceneId": "lng_02", "cueId": "cap_02", "text": display, "userEdited": False}],
    })
    blank_wins = peaked(12, 6, [(3, 2)])
    for row in blank_wins:
        row[0] = -0.01
        row[2] = -4.0
    compare({
        "display": "ا",
        "logProbs": blank_wins,
        "tokenIds": [2],
        "blankId": 0,
        "spaceId": 1,
        "frameSec": 0.02,
        "audioDurationSec": 1.0,
        "words": ["ا"],
        "units": [{"sceneId": "lng_01", "cueId": None, "text": "ا", "userEdited": False}],
    })
    print("port_matches_typescript=yes")


if __name__ == "__main__":
    main()
