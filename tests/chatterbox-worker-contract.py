#!/usr/bin/env python3
"""Offline contract tests for tools/chatterbox/worker.py.

These tests import the real worker and call its real functions. Stub modules
stand in for torch, perth and the Chatterbox classes. Nothing here downloads
weights, imports torch, or runs inference.
"""

from __future__ import annotations

import inspect
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools" / "chatterbox"))


def install_stubs() -> None:
    perth = types.ModuleType("perth")

    class PerthImplicitWatermarker:
        def apply_watermark(self, wav, sample_rate):
            return wav

    perth.PerthImplicitWatermarker = PerthImplicitWatermarker
    sys.modules["perth"] = perth

    torch = types.ModuleType("torch")
    torch.__version__ = "stub"
    torch.cuda = types.SimpleNamespace(
        is_available=lambda: True,
        current_device=lambda: 0,
        get_device_name=lambda _index: "stub-gpu",
    )
    torch.version = types.SimpleNamespace(cuda="stub")
    sys.modules["torch"] = torch


install_stubs()
import worker  # noqa: E402


UPSTREAM_GENERATE_PARAMS = [
    "self",
    "text",
    "language_id",
    "audio_prompt_path",
    "exaggeration",
    "cfg_weight",
    "temperature",
    "repetition_penalty",
    "min_p",
    "top_p",
]


class WatermarkContract(unittest.TestCase):
    def test_perth_and_watermarker_confirm(self):
        model = types.SimpleNamespace(watermarker=sys.modules["perth"].PerthImplicitWatermarker())
        self.assertTrue(worker.confirm_watermark(model))

    def test_missing_module_refuses(self):
        saved = sys.modules.pop("perth", None)
        try:
            self.assertFalse(worker.confirm_watermark(types.SimpleNamespace(watermarker=object())))
        finally:
            if saved is not None:
                sys.modules["perth"] = saved

    def test_missing_watermarker_refuses_even_if_library_imports(self):
        self.assertFalse(worker.confirm_watermark(types.SimpleNamespace(watermarker=None)))


class GenerateContract(unittest.TestCase):
    def test_cuda_generate_uses_the_upstream_signature(self):
        calls = []

        def generate(text, language_id, audio_prompt_path=None, exaggeration=0.5,
                     cfg_weight=0.5, temperature=0.8, repetition_penalty=1.2,
                     min_p=0.05, top_p=1.0):
            calls.append(inspect.signature(generate).bind(text, language_id, audio_prompt_path,
                                                          exaggeration, cfg_weight, temperature,
                                                          repetition_penalty, min_p, top_p).arguments)
            # Reject the defect the probe found: device is not a generate argument.
            if "device" in calls[-1]:
                raise TypeError("unexpected keyword argument 'device'")
            return "wav"

        model = types.SimpleNamespace(generate=generate)
        contract = worker.CONTRACTS["chatterbox-multilingual-v3"]
        worker.synthesize(
            model, contract, "hello", "en", "ref.wav",
            {"exaggeration": 0.5, "cfgWeight": 0.4, "minP": 0.05}, "cuda",
        )
        self.assertNotIn("device", calls[0])
        self.assertEqual(calls[0]["exaggeration"], 0.5)
        self.assertEqual(calls[0]["cfg_weight"], 0.4)
        self.assertEqual(calls[0]["min_p"], 0.05)
        self.assertEqual(list(inspect.signature(generate).parameters), UPSTREAM_GENERATE_PARAMS[1:])

    def test_unsupported_setting_is_not_silently_dropped(self):
        def generate(text, language_id, audio_prompt_path=None):
            return "wav"

        model = types.SimpleNamespace(generate=generate)
        contract = dict(worker.CONTRACTS["chatterbox-multilingual-v3"])
        with self.assertRaises(worker.WorkerError) as caught:
            worker.synthesize(
                model, contract, "hello", "en", "ref.wav",
                {"exaggeration": 0.7, "cfgWeight": 0.3}, "cpu",
            )
        self.assertIn(caught.exception.category, {"SYNTHESIS_FAILED", "INTERNAL_ERROR"})


class VariantContract(unittest.TestCase):
    def test_multilingual_load_selects_v3_explicitly(self):
        seen = {}

        class ChatterboxMultilingualTTS:
            @classmethod
            def from_local(cls, ckpt_dir, device, t3_model=None):
                seen["ckpt_dir"] = ckpt_dir
                seen["device"] = device
                seen["t3_model"] = t3_model
                seen["calls"] = seen.get("calls", 0) + 1
                return types.SimpleNamespace(t3_model=t3_model, watermarker=object())

            @classmethod
            def from_pretrained(cls, device, t3_model=None):
                raise AssertionError("offline load must not call from_pretrained")

        module = types.ModuleType("chatterbox.mtl_tts")
        module.ChatterboxMultilingualTTS = ChatterboxMultilingualTTS
        sys.modules["chatterbox.mtl_tts"] = module
        sys.modules["chatterbox"] = types.ModuleType("chatterbox")

        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp) / "snap"
            snapshot.mkdir()
            (snapshot / "t3_mtl23ls_v3.safetensors").write_bytes(b"v3")
            model = worker.load_model(
                worker.CONTRACTS["chatterbox-multilingual-v3"],
                "cpu",
                "ResembleAI/chatterbox",
                snapshot_dir=str(snapshot),
            )
        self.assertEqual(seen["t3_model"], "v3")
        self.assertEqual(seen["device"], "cpu")
        self.assertEqual(getattr(model, "t3_model", None), "v3")

    def test_variant_mismatch_does_not_fall_back(self):
        calls = []

        class ChatterboxMultilingualTTS:
            @classmethod
            def from_local(cls, ckpt_dir, device, t3_model=None):
                calls.append(t3_model)
                return types.SimpleNamespace(t3_model="v2", watermarker=object())

            @classmethod
            def from_pretrained(cls, device, t3_model=None):
                calls.append(("pretrained", t3_model))
                return types.SimpleNamespace(t3_model="v2")

        module = types.ModuleType("chatterbox.mtl_tts")
        module.ChatterboxMultilingualTTS = ChatterboxMultilingualTTS
        sys.modules["chatterbox.mtl_tts"] = module

        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp) / "snap"
            snapshot.mkdir()
            (snapshot / "t3_mtl23ls_v2.safetensors").write_bytes(b"v2")
            with self.assertRaises(worker.WorkerError) as caught:
                worker.load_model(
                    worker.CONTRACTS["chatterbox-multilingual-v3"],
                    "cpu",
                    "ResembleAI/chatterbox",
                    snapshot_dir=str(snapshot),
                )
        self.assertEqual(caught.exception.category, "MODEL_REVISION_MISMATCH")
        self.assertNotIn("v2", calls)
        self.assertFalse(any(item == ("pretrained", None) or item == ("pretrained", "v2") for item in calls))

    def test_pinned_signature_without_t3_model_does_not_load_v2(self):
        calls = []

        class ChatterboxMultilingualTTS:
            @classmethod
            def from_pretrained(cls, device):
                calls.append(device)
                return types.SimpleNamespace(t3_model="v2")

        module = types.ModuleType("chatterbox.mtl_tts")
        module.ChatterboxMultilingualTTS = ChatterboxMultilingualTTS
        sys.modules["chatterbox.mtl_tts"] = module
        with self.assertRaises(worker.WorkerError) as caught:
            worker.load_model(
                worker.CONTRACTS["chatterbox-multilingual-v3"],
                "cpu",
                "ResembleAI/chatterbox",
                snapshot_dir=None,
            )
        self.assertEqual(caught.exception.category, "MODEL_REVISION_MISMATCH")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
