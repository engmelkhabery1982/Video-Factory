"""Stdlib unit tests for greedy CTC decoding. Run: python3 -m unittest test_ctc_greedy -v"""
import unittest

from ctc_greedy import decode_transcript, greedy_path, transcript_provenance

BLANK = 0


def one_hot(index: int, vocab: int = 6) -> list[float]:
    row = [-9.0] * vocab
    row[index] = -0.01
    return row


class GreedyPathTests(unittest.TestCase):
    def test_collapses_repeats_and_drops_blanks(self):
        frames = [one_hot(i) for i in [BLANK, 2, 2, BLANK, 2, 3, 3, BLANK]]
        self.assertEqual(greedy_path(frames, BLANK), [2, 2, 3])

    def test_all_blank_is_empty(self):
        self.assertEqual(greedy_path([one_hot(BLANK)] * 4, BLANK), [])

    def test_argmax_not_first_index(self):
        frames = [[-5.0, -4.0, -0.1, -3.0]]
        self.assertEqual(greedy_path(frames, 0), [2])

    def test_empty_input(self):
        self.assertEqual(greedy_path([], BLANK), [])


class DecodeTests(unittest.TestCase):
    def test_decodes_through_the_supplied_decoder_and_reports_counts(self):
        frames = [one_hot(i) for i in [1, BLANK, 2, 2]]
        table = {1: "a", 2: "b"}
        result = decode_transcript(frames, BLANK, lambda ids: "".join(table[i] for i in ids))
        self.assertEqual(result, {"text": "ab", "tokenCount": 2, "frames": 4})

    def test_whitespace_is_normalised_not_invented(self):
        frames = [one_hot(1), one_hot(BLANK), one_hot(2)]
        result = decode_transcript(frames, BLANK, lambda ids: "  x   y ")
        self.assertEqual(result["text"], "x y")

    def test_no_emissions_gives_empty_text_without_calling_decoder(self):
        calls = []
        result = decode_transcript([one_hot(BLANK)], BLANK, lambda ids: calls.append(ids) or "never")
        self.assertEqual(result["text"], "")
        self.assertEqual(calls, [])


class ProvenanceTests(unittest.TestCase):
    def test_provenance_states_independence_and_no_script_copy(self):
        p = transcript_provenance(
            audio_sha256="a" * 64, emissions_sha256="b" * 64, frames=10, blank_id=0, tokenizer_bytes=1, decoder="fairseq2-char",
        )
        self.assertEqual(p["method"], "greedy_ctc")
        self.assertTrue(p["independentOfScript"])
        self.assertFalse(p["scriptCopied"])
        self.assertFalse(p["fixture"])


if __name__ == "__main__":
    unittest.main()
