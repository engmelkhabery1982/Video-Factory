"""Stdlib tests for script-free transcription logic. Run: python3 -m unittest test_transcribe_recording -v

These run the chunk plan, stitching, digest and collapse with a SYNTHETIC frame stream whose frame index is known.
They prove the stitching equals the global greedy path. They are not evidence of model accuracy: no model runs here.
"""
import hashlib
import inspect
import struct
import unittest

import ctc_transcribe as ct
import transcribe_recording as tr
from ctc_greedy import greedy_path

SR = 16000
FRAME = 320  # 20 ms at 16 kHz
BLANK = 0


def global_ids(n_frames: int) -> list[int]:
    # Blank every third frame; tokens change every three frames, so repeats cross chunk edges.
    return [BLANK if g % 3 == 0 else 1 + (g // 3) % 4 for g in range(n_frames)]


def frame_bytes(g: int) -> bytes:
    return struct.pack("<f", float(g))


def synthetic_forward(total_samples: int, *, frame_sec_override=None, empty_at=None):
    calls = []

    def forward(start, end):
        calls.append((start, end))
        assert start % FRAME == 0 and end % FRAME == 0
        first, last = start // FRAME, end // FRAME
        if empty_at is not None and start == empty_at:
            return [], 0.02, b""
        frames = list(range(first, last))
        ids = [global_ids(last)[g] for g in frames]
        sec = (end - start) / SR / len(frames)
        if frame_sec_override is not None and start > 0:
            sec = frame_sec_override
        payload = b"".join(frame_bytes(g) for g in frames)
        return ids, sec, payload

    forward.calls = calls
    return forward


class CollapseTests(unittest.TestCase):
    def test_matches_the_forced_path_greedy_semantics(self):
        ids = [BLANK, 2, 2, BLANK, 2, 3, 3, BLANK, 3]
        rows = [[(-9.0 if i != k else -0.01) for i in range(6)] for k in ids]
        self.assertEqual(ct.collapse_ids(ids, BLANK), greedy_path(rows, BLANK))
        self.assertEqual(ct.collapse_ids(ids, BLANK), [2, 2, 3, 3])  # the repeat across a blank is kept

    def test_all_blank_is_empty(self):
        self.assertEqual(ct.collapse_ids([0, 0, 0], BLANK), [])


class ChunkStitchTests(unittest.TestCase):
    def test_long_recording_stitches_to_the_global_path_and_digest(self):
        total = 75 * SR  # not a multiple of the 20 s chunk
        n = total // FRAME
        forward = synthetic_forward(total)

        def refuse_full(start, end):
            if (start, end) == (0, total):
                raise RuntimeError("out of memory (synthetic)")
            return forward(start, end)

        result = ct.greedy_over_audio(total, refuse_full)
        self.assertEqual(result["extraction"]["mode"], "chunked_forward")
        self.assertIn("out of memory", result["extraction"]["fullForwardError"])
        self.assertEqual(ct.collapse_ids(result["ids"], BLANK), ct.collapse_ids(global_ids(n), BLANK))
        self.assertEqual(result["frames"], n)
        expected_digest = hashlib.sha256(b"".join(frame_bytes(g) for g in range(n))).hexdigest()
        self.assertEqual(result["emissionsSha256"], expected_digest)
        # Overlapping windows were actually requested: 0..20 s, 16..36 s, ...
        self.assertEqual([s for s, _ in forward.calls][:3], [0, 16 * SR, 32 * SR])

    def test_chunk_plan_overlap_and_edges(self):
        total = 45 * SR
        fwd = synthetic_forward(total)
        ct.stream_chunked(total, fwd)
        starts = [s for s, _ in fwd.calls]
        ends = [e for _, e in fwd.calls]
        self.assertEqual(starts, [0, 16 * SR, 32 * SR])
        self.assertEqual(ends, [20 * SR, 36 * SR, 45 * SR])

    def test_full_forward_when_it_succeeds_is_one_call(self):
        total = 10 * SR
        fwd = synthetic_forward(total)
        result = ct.greedy_over_audio(total, fwd)
        self.assertEqual(result["extraction"]["mode"], "full_forward")
        self.assertEqual(fwd.calls, [(0, total)])
        self.assertEqual(result["ids"], global_ids(total // FRAME))

    def test_inconsistent_frame_duration_is_refused_not_repaired(self):
        # A wrong frame duration moves the next chunk's origin, so the contiguity check refuses it first.
        # Either refusal is a refusal: nothing is repaired and no transcript is produced.
        total = 45 * SR
        fwd = synthetic_forward(total, frame_sec_override=0.0201)
        with self.assertRaises(ValueError):
            ct.stream_chunked(total, fwd)

    def test_an_empty_chunk_is_refused(self):
        total = 45 * SR
        fwd = synthetic_forward(total, empty_at=16 * SR)
        with self.assertRaisesRegex(ValueError, "no frames"):
            ct.stream_chunked(total, fwd)


class TranscriptTests(unittest.TestCase):
    def test_decoder_receives_only_the_collapsed_path_of_these_ids(self):
        seen = []

        def decode(path):
            seen.append(list(path))
            return "".join(str(i) for i in path)

        out = ct.transcript_from_ids([BLANK, 2, 2, BLANK, 3], BLANK, decode)
        self.assertEqual(seen, [[2, 3]])
        self.assertEqual(out["text"], "23")

    def test_no_text_input_exists_in_the_runner(self):
        # The runner's inputs are audio, output, checkpoint and tokenizer only.
        source = inspect.getsource(tr.main)
        flags = [line for line in source.splitlines() if "add_argument" in line]
        self.assertEqual(len(flags), 5)
        for flag in flags:
            self.assertNotRegex(flag.lower(), r"script|caption|text|align|target")


if __name__ == "__main__":
    unittest.main()
