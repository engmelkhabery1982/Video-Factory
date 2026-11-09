"""Extract official CTC frame logits and align the known project script.

Prepared code. It does not download weights by itself and does not write the
project, the recording, or saved timings. Review files go only to --review-dir.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import traceback
from pathlib import Path

from ctc_greedy import decode_transcript, transcript_provenance

from ctc_forced import (
    forced_align_ctc,
    normalize_for_match,
    proposal_from_aligned_words,
    unavailable_proposal,
    words_from_token_spans,
)

# The identity of the WAV is NOT a constant here. The API writes the expected
# sha256, byte size and duration of the current narration import into a job file
# (--expected-audio-json), and this runner refuses any other file.
SAMPLE_RATE = 16000
SOURCE_RATE = 24000
CHECKPOINT_BYTES = 1304065508
TOKENIZER_BYTES = 91481
SECOND_SENTENCE = "تنظر إلى ما فقدت"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_wav_facts(path: Path) -> dict:
    data = path.read_bytes()
    if len(data) < 44 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not a RIFF WAVE file")
    offset = 12
    audio_format = channels = rate = bits = None
    data_bytes = None
    while offset + 8 <= len(data):
        chunk_id = data[offset:offset + 4]
        size = int.from_bytes(data[offset + 4:offset + 8], "little")
        start = offset + 8
        if chunk_id == b"fmt ":
            audio_format = int.from_bytes(data[start:start + 2], "little")
            channels = int.from_bytes(data[start + 2:start + 4], "little")
            rate = int.from_bytes(data[start + 4:start + 8], "little")
            bits = int.from_bytes(data[start + 14:start + 16], "little")
        elif chunk_id == b"data":
            data_bytes = size
            break
        offset = start + size + (size % 2)
    if None in (audio_format, channels, rate, bits, data_bytes):
        raise ValueError("WAV header is missing fmt or data")
    duration = round(data_bytes / (rate * channels * (bits / 8.0)), 3)
    return {
        "bytes": len(data),
        "audioFormat": audio_format,
        "channels": channels,
        "sampleRate": rate,
        "bits": bits,
        "dataBytes": data_bytes,
        "durationSec": duration,
    }


def load_expected_identity(path: Path | None) -> dict:
    """The job's expected WAV identity. Missing or malformed means no alignment."""
    if path is None or not path.is_file():
        raise SystemExit("BLOCKER=expected_audio_identity_missing")
    value = load_json(path)
    sha = value.get("sha256")
    size = value.get("bytes")
    duration = value.get("durationSec")
    if not isinstance(sha, str) or len(sha) != 64 or not isinstance(size, int) or isinstance(size, bool):
        raise SystemExit("BLOCKER=expected_audio_identity_invalid")
    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration) or duration <= 0:
        raise SystemExit("BLOCKER=expected_audio_identity_invalid")
    return {"sha256": sha, "bytes": size, "durationSec": float(duration)}


def assert_project_wav(path: Path, expected: dict) -> dict:
    if not path.is_file():
        raise SystemExit(f"BLOCKER=wav_missing path={path}")
    digest = sha256_file(path)
    facts = read_wav_facts(path)
    if digest != expected["sha256"] or facts["bytes"] != expected["bytes"]:
        raise SystemExit(f"BLOCKER=wav_identity mismatch sha={digest} bytes={facts['bytes']}")
    # Supported input format (not identity): 24 kHz mono 16-bit PCM.
    if facts["audioFormat"] != 1 or facts["channels"] != 1 or facts["sampleRate"] != SOURCE_RATE or facts["bits"] != 16:
        raise SystemExit(f"BLOCKER=wav_format {facts}")
    if abs(facts["durationSec"] - expected["durationSec"]) > 0.001:
        raise SystemExit(f"BLOCKER=wav_duration {facts['durationSec']} expected {expected['durationSec']}")
    facts["sha256"] = digest
    return facts


def expected_path_of(args: argparse.Namespace) -> Path | None:
    return Path(args.expected_audio_json) if getattr(args, "expected_audio_json", None) else None


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise SystemExit(f"BLOCKER=json_not_object path={path}")
    return value


def spoken_units(project: dict) -> tuple[list[dict], list[dict]]:
    scenes = project.get("storyboard", {}).get("long", {}).get("scenes")
    captions = project.get("storyboard", {}).get("captions") or []
    if not isinstance(scenes, list) or not scenes:
        raise SystemExit("BLOCKER=project_has_no_long_scenes")
    units = []
    empty = []
    for scene in scenes:
        text = str(scene.get("narration") or "")
        cue = next((item for item in captions if item.get("sceneId") == scene.get("id")), None)
        record = {
            "sceneId": scene.get("id"),
            "cueId": None if cue is None else cue.get("id"),
            "text": text,
            "userEdited": scene.get("userEdited") is True or (cue or {}).get("userEdited") is True,
            "savedStart": scene.get("startTime"),
            "savedDuration": scene.get("duration"),
        }
        if text.strip():
            units.append(record)
        else:
            empty.append({**record, "reason": "This scene has no known spoken text. No time was estimated for it."})
    if not units:
        raise SystemExit("BLOCKER=no_spoken_scenes")
    return units, empty


def self_test_forward() -> None:
    import torch
    from fairseq2.models.wav2vec2.asr import get_wav2vec2_asr_model_hub
    from fairseq2.nn.batch_layout import BatchLayout

    version = torch.__version__
    if torch.cuda.is_available() or not version.startswith("2.8.0+cpu"):
        raise SystemExit(f"BLOCKER=torch_is_not_cpu_build:{version} cuda={torch.cuda.is_available()}")
    hub = get_wav2vec2_asr_model_hub()
    config = hub.get_arch_config("base_10h")
    config.target_vocab_size = 8
    config.use_masking = False
    config.encoder_config.num_encoder_layers = 1
    model = hub.create_new_model(config, device=torch.device("cpu"), dtype=torch.float32).eval()
    wave = torch.zeros(1, 16000)
    layout = BatchLayout(wave.shape, seq_lens=[16000], device=wave.device)
    with torch.inference_mode():
        logits, out = model(wave, layout)
    if not torch.isfinite(logits).all():
        raise SystemExit("BLOCKER=forward_logits_not_finite")
    frames = int(out.seq_lens[0])
    log_probs = torch.log_softmax(logits[0, :frames].float(), dim=-1).tolist()
    planted = [[-20.0] * 8 for _ in range(frames)]
    for row in planted:
        row[0] = -5.0
    for frame in range(2, 6):
        planted[frame][3] = -0.1
        planted[frame][0] = -8.0
    aligned = forced_align_ctc(planted, [3], 0, 320 / 16000)
    if not aligned["ok"]:
        raise SystemExit("BLOCKER=forward_logits_did_not_feed_aligner " + aligned["reason"])
    print(json.dumps({
        "forwardClass": type(model).__name__,
        "torch": version,
        "cuda": False,
        "logitsShape": list(logits.shape),
        "alignerOk": True,
        "span": aligned["spans"][0],
        "officialWeightsUsed": False,
    }, ensure_ascii=False))


def load_official_model(checkpoint: Path):
    import torch
    import omnilingual_asr
    from fairseq2.models.wav2vec2.asr import get_wav2vec2_asr_model_hub
    from fairseq2.runtime.dependency import get_dependency_resolver

    if not torch.__version__.startswith("2.8.0+cpu") or torch.cuda.is_available():
        raise SystemExit(f"BLOCKER=torch_is_not_cpu_build:{torch.__version__} cuda={torch.cuda.is_available()}")
    hub = get_wav2vec2_asr_model_hub()
    if "300m_v2" not in hub.get_archs():
        try:
            omnilingual_asr.setup_fairseq2_extension(get_dependency_resolver())
        except Exception as exc:
            hub = get_wav2vec2_asr_model_hub()
            if "300m_v2" not in hub.get_archs():
                raise SystemExit(f"BLOCKER=300m_v2_arch_missing {exc}") from exc
        hub = get_wav2vec2_asr_model_hub()
    if "300m_v2" not in hub.get_archs():
        raise SystemExit("BLOCKER=300m_v2_arch_missing")
    config = hub.get_arch_config("300m_v2")
    if config.target_vocab_size != 10288:
        raise SystemExit(f"BLOCKER=unexpected_vocab {config.target_vocab_size}")
    # mmap across the WSL Windows drive mount is unreliable. The file stays where it was downloaded.
    model = hub.load_custom_model(
        checkpoint,
        config,
        device=torch.device("cpu"),
        dtype=torch.float32,
        mmap=False,
        progress=False,
    )
    model.eval()
    return model


def load_tokenizer(path: Path):
    from fairseq2.data.tokenizers.char import load_char_tokenizer

    tokenizer = load_char_tokenizer(path, None)
    info = tokenizer.vocab_info
    if info.pad_idx is None:
        raise SystemExit("BLOCKER=tokenizer_has_no_blank")
    return tokenizer, int(info.pad_idx), {idx for idx in (info.pad_idx, info.bos_idx, info.eos_idx, info.unk_idx) if idx is not None}


def encode_ids(encoder, text: str, specials: set[int]) -> list[int]:
    encoded = encoder(text)
    ids = [int(item) for item in (encoded.tolist() if hasattr(encoded, "tolist") else encoded)]
    while ids and ids[0] in specials:
        ids.pop(0)
    while ids and ids[-1] in specials:
        ids.pop()
    return ids


def prepare_waveform(wav_path: Path):
    """Decode, resample to 16 kHz, mono, full-waveform layer_norm. Shared by alignment and transcription.

    Does not check any duration and does not call transcribe(). Callers that know an expected duration check it.
    """
    import torch
    from fairseq2.data._memory import MemoryBlock
    from fairseq2.data.audio import AudioDecoder
    from omnilingual_asr.datasets.utils.audio import apply_audio_normalization, convert_to_mono
    from omnilingual_asr.models.inference.pipeline import resample_to_16khz

    decoded = AudioDecoder(dtype=torch.float32)(MemoryBlock(wav_path.read_bytes()))
    audio = {"waveform": decoded["waveform"], "sample_rate": int(decoded["sample_rate"])}
    if audio["sample_rate"] != SOURCE_RATE:
        raise SystemExit(f"BLOCKER=unexpected_sample_rate {audio['sample_rate']}")
    audio = resample_to_16khz(audio)
    samples = convert_to_mono(audio["waveform"]).to(torch.float32)
    if samples.dim() != 1:
        raise SystemExit(f"BLOCKER=waveform_not_mono_vector shape={tuple(samples.shape)}")
    return apply_audio_normalization(samples)


def resample_and_normalize(wav_path: Path, duration_sec: float):
    """Match the official pipeline (see prepare_waveform), then check the length against the expected duration.

    The 40-second transcription cap is not applied. This does not call transcribe().
    """
    samples = prepare_waveform(wav_path)
    expected = int(round(duration_sec * SAMPLE_RATE))
    if abs(int(samples.numel()) - expected) > SAMPLE_RATE:
        raise SystemExit(f"BLOCKER=resampled_length {int(samples.numel())} expected_near={expected}")
    return samples


def forward_log_probs(model, samples):
    import torch
    from fairseq2.nn.batch_layout import BatchLayout

    wave = samples.reshape(1, -1)
    layout = BatchLayout(wave.shape, seq_lens=[int(wave.shape[1])], device=wave.device)
    with torch.inference_mode():
        logits, out = model(wave, layout)
    count = int(out.seq_lens[0])
    logits = logits[0, :count].float()
    if not torch.isfinite(logits).all():
        raise RuntimeError("non-finite logits")
    return torch.log_softmax(logits, dim=-1)


def extract_emissions(model, samples) -> tuple[list[list[float]], float, dict]:
    import torch

    torch.set_num_threads(min(4, torch.get_num_threads()))
    try:
        log_probs = forward_log_probs(model, samples)
        frame_sec = (samples.numel() / SAMPLE_RATE) / log_probs.shape[0]
        return log_probs.tolist(), frame_sec, {"mode": "full_forward", "frames": int(log_probs.shape[0]), "transcribeCalled": False}
    except (RuntimeError, MemoryError) as exc:
        failure = str(exc)
    chunk = 20 * SAMPLE_RATE
    overlap = 4 * SAMPLE_RATE
    drop = 2 * SAMPLE_RATE
    pieces = []
    start = 0
    total = int(samples.numel())
    while start < total:
        end = min(total, start + chunk)
        local = forward_log_probs(model, samples[start:end])
        local_sec = ((end - start) / SAMPLE_RATE) / local.shape[0]
        left = 0 if start == 0 else int(round(drop / SAMPLE_RATE / local_sec))
        right = 0 if end == total else int(round(drop / SAMPLE_RATE / local_sec))
        stop = local.shape[0] - right if right else local.shape[0]
        kept = local[left:stop]
        if kept.shape[0] == 0:
            raise SystemExit("BLOCKER=chunk_stitch_removed_every_frame")
        origin = start / SAMPLE_RATE + left * local_sec
        pieces.append({"origin": origin, "frameSec": local_sec, "rows": kept.tolist()})
        if end == total:
            break
        start = end - overlap
    frame_secs = [piece["frameSec"] for piece in pieces]
    if max(frame_secs) - min(frame_secs) > 0.001:
        raise SystemExit("BLOCKER=chunk_frame_duration_mismatch")
    rows: list[list[float]] = []
    previous_end = None
    for piece in pieces:
        if previous_end is not None and abs(piece["origin"] - previous_end) > piece["frameSec"] * 1.5:
            raise SystemExit("BLOCKER=chunk_stitch_not_contiguous")
        rows.extend(piece["rows"])
        previous_end = piece["origin"] + len(piece["rows"]) * piece["frameSec"]
    return rows, frame_secs[0], {
        "mode": "chunked_forward",
        "fullForwardError": failure,
        "frames": len(rows),
        "chunks": len(pieces),
        "chunkSec": 20,
        "overlapSec": 4,
        "edgeDiscardSec": 2,
        "transcribeCalled": False,
    }


def separator_ids(encoder, specials: set[int]) -> list[int]:
    """Resolve an official tokenizer separator without inventing a token index."""
    space_ids = encode_ids(encoder, " ", specials)
    if not space_ids:
        # SentencePiece strips isolated whitespace. This is the previously
        # verified owner-host fix: validate both surrounding character encodings.
        left = encode_ids(encoder, "ا", specials)
        right = encode_ids(encoder, "ب", specials)
        contextual = encode_ids(encoder, "ا ب", specials)
        if left and right and contextual[:len(left)] == left and contextual[-len(right):] == right:
            space_ids = contextual[len(left):-len(right)]
    return space_ids


def align_known(log_probs, frame_sec: float, units: list[dict], tokenizer_path: Path, audio_duration: float) -> dict:
    tokenizer, blank_id, specials = load_tokenizer(tokenizer_path)
    encoder = tokenizer.create_raw_encoder()
    space_ids = separator_ids(encoder, specials)
    if len(space_ids) != 1:
        return {
            "proposal": unavailable_proposal("The character tokenizer did not encode one space token. Sentence times were not guessed."),
            "sentenceReview": [{"sceneId": unit["sceneId"], "text": unit["text"], "placed": False, "reason": "space token unavailable"} for unit in units],
            "blankId": blank_id,
        }
    space_id = space_ids[0]
    unresolved = []
    pieces = []
    ranges = []
    cursor = 0
    for index, unit in enumerate(units):
        normalized = normalize_for_match(unit["text"])
        ids = encode_ids(encoder, normalized, specials)
        if not ids or len(ids) != len(normalized) or any(token_id == blank_id or token_id in specials for token_id in ids):
            unresolved.append({
                "sceneId": unit["sceneId"],
                "text": unit["text"],
                "reason": f"The known sentence could not be encoded character-for-character (normalized length {len(normalized)}, token length {len(ids)}). Its time was not estimated.",
            })
            continue
        if pieces:
            pieces.append(space_id)
            cursor += 1
        ranges.append((unit, cursor, cursor + len(ids)))
        pieces.extend(ids)
        cursor += len(ids)
    if unresolved:
        return {
            "proposal": unavailable_proposal(
                "At least one known sentence is outside the CTC vocabulary. No sentence time was estimated, and pause timing was not used.",
                unresolved,
            ),
            "sentenceReview": [
                {"sceneId": item["sceneId"], "text": item["text"], "placed": False, "reason": item["reason"]}
                for item in unresolved
            ],
            "blankId": blank_id,
            "spaceId": space_id,
        }
    aligned = forced_align_ctc(log_probs, pieces, blank_id, frame_sec)
    review = []
    words_by_scene = {}
    if not aligned["ok"]:
        for unit, _start, _end in ranges:
            review.append({"sceneId": unit["sceneId"], "text": unit["text"], "placed": False, "reason": aligned["reason"], "shortSentence": len(unit["text"].split()) <= 3})
        return {"proposal": unavailable_proposal(aligned["reason"]), "sentenceReview": review, "blankId": blank_id, "spaceId": space_id}
    for unit, start, end in ranges:
        words = [part for part in unit["text"].split() if part]
        word_spans = words_from_token_spans(words, aligned["spans"][start:end], space_id)
        words_by_scene[unit["sceneId"]] = word_spans
        placed = len(word_spans) == len(words) and all(word["supported"] and word["end"] > word["start"] for word in word_spans)
        review.append({
            "sceneId": unit["sceneId"],
            "cueId": unit["cueId"],
            "text": unit["text"],
            "userEdited": unit["userEdited"],
            "wordCount": len(words),
            "shortSentence": len(words) <= 3,
            "placed": placed,
            "wordStarts": word_spans if placed else [],
            "reason": "" if placed else "One or more words have no supported acoustic span.",
        })
    proposal = proposal_from_aligned_words(audio_duration, units, words_by_scene)
    if proposal["available"]:
        by_id = {row["sceneId"]: row for row in proposal["rows"]}
        for item in review:
            row = by_id.get(item["sceneId"])
            if row:
                item.update({
                    "proposedStart": row["proposedStart"],
                    "proposedDurationSec": row["proposedDurationSec"],
                    "proposedCaptionStart": row["proposedCaptionStart"],
                    "proposedCaptionEnd": row["proposedCaptionEnd"],
                })
    return {"proposal": proposal, "sentenceReview": review, "blankId": blank_id, "spaceId": space_id, "tokenCount": len(pieces)}


def second_sentence_report(review: list[dict]) -> dict:
    needle = normalize_for_match(SECOND_SENTENCE)
    match = next((item for item in review if needle in normalize_for_match(item["text"])), None)
    report = {
        "query": SECOND_SENTENCE,
        "offsetApplied": False,
        "hardcodedStartUsed": False,
    }
    if match is None:
        report.update({"found": False, "reason": "No known sentence contains this text. No start was invented."})
        return report
    report.update({
        "found": True,
        "sceneId": match["sceneId"],
        "text": match["text"],
        "placed": match.get("placed") is True,
        "proposedStart": match.get("proposedStart"),
        "reason": match.get("reason") or "",
    })
    return report


def write_reviews(review_dir: Path, payload: dict) -> None:
    review_dir.mkdir(parents=True, exist_ok=True)
    boundaries = review_dir / "boundaries.json"
    diagnostics = review_dir / "diagnostics.json"
    listen = review_dir / "listen.txt"
    boundaries.write_text(json.dumps(payload["boundaries"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    diagnostics.write_text(json.dumps(payload["diagnostics"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    listen.write_text(payload["listen"], encoding="utf-8")
    print(json.dumps({"boundaries": str(boundaries), "diagnostics": str(diagnostics), "listen": str(listen)}, ensure_ascii=False))


def listen_text(review: list[dict], second: dict, audio_duration: float) -> str:
    placed = [item for item in review if item.get("placed") and "proposedStart" in item]
    lines = [
        "Prepared review only. Saved timings were not changed. This is not a listening approval.",
        "Seek the unchanged project WAV to these proposed starts. Do not treat a missing start as silence timing.",
        f"Recording duration: {audio_duration:.3f}s",
        "",
    ]
    if placed:
        lines.append(f"start: {placed[0]['sceneId']} {placed[0]['proposedStart']:.3f}s {placed[0]['text']}")
        middle = placed[len(placed) // 2]
        lines.append(f"middle: {middle['sceneId']} {middle['proposedStart']:.3f}s {middle['text']}")
        short = min(placed, key=lambda item: item.get("wordCount", 99))
        lines.append(f"short: {short['sceneId']} {short['proposedStart']:.3f}s words={short.get('wordCount')} {short['text']}")
        lines.append(f"end: {placed[-1]['sceneId']} {placed[-1]['proposedStart']:.3f}s {placed[-1]['text']}")
    else:
        lines.append("No sentence received a supported acoustic start. Nothing was estimated.")
    lines.append("")
    if second.get("found") and second.get("proposedStart") is not None:
        lines.append(
            f"second-sentence candidate: {second['sceneId']} proposedStart={second['proposedStart']:.3f}s text={second['text']}"
        )
    else:
        lines.append("second-sentence candidate: not placed. " + second.get("reason", ""))
    lines.append("An earlier approximate listening note was not written into the aligner and was not applied as an offset.")
    lines.append("Play-from-here was not verified because saved timings were not replaced.")
    lines.append("")
    for item in review:
        start = item.get("proposedStart")
        start_text = f"{start:.3f}" if isinstance(start, float) else "unresolved"
        lines.append(f"{item['sceneId']}\t{start_text}\t{item.get('reason') or 'placed'}\t{item['text']}")
    return "\n".join(lines) + "\n"


def emissions_paths(review_dir: Path) -> tuple[Path, Path]:
    return review_dir / "emissions.npy", review_dir / "emissions-meta.json"


def assert_review_outside_project(review_dir: Path, wav: Path) -> None:
    review = review_dir.resolve()
    recording = wav.resolve()
    data_dir = recording.parent.parent if recording.parent.name == "voiceover" else recording.parent
    overlaps = review == data_dir or review == recording or data_dir in review.parents or review in data_dir.parents
    if overlaps:
        raise SystemExit(f"BLOCKER=review_dir_overlaps_project_data review={review}")


def extract_only(args: argparse.Namespace) -> None:
    import numpy as np

    wav = Path(args.wav)
    checkpoint = Path(args.checkpoint)
    review_dir = Path(args.review_dir)
    facts = assert_project_wav(wav, load_expected_identity(expected_path_of(args)))
    assert_review_outside_project(review_dir, wav)
    review_dir.mkdir(parents=True, exist_ok=True)
    if checkpoint.stat().st_size != CHECKPOINT_BYTES or checkpoint.read_bytes()[:2] != b"PK":
        raise SystemExit("BLOCKER=checkpoint_integrity")
    model = load_official_model(checkpoint)
    samples = resample_and_normalize(wav, facts["durationSec"])
    log_probs, frame_sec, extraction = extract_emissions(model, samples)
    npy, meta = emissions_paths(review_dir)
    np.save(npy, np.asarray(log_probs, dtype=np.float32))
    meta.write_text(json.dumps({
        "audioSha256": facts["sha256"],
        "frameSec": frame_sec,
        "frames": len(log_probs),
        "vocab": len(log_probs[0]) if log_probs else 0,
        "extraction": extraction,
        "officialWeightsUsed": True,
        "savedTimingsModified": False,
    }, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"emissions": str(npy), "frames": len(log_probs), "frameSec": frame_sec, "mode": extraction["mode"]}, ensure_ascii=False))


def align_from_emissions(args: argparse.Namespace) -> None:
    import numpy as np

    wav = Path(args.wav)
    project_path = Path(args.project_json)
    state_path = Path(args.state_json)
    tokenizer = Path(args.tokenizer)
    review_dir = Path(args.review_dir)
    npy, meta_path = emissions_paths(review_dir)
    before = {"wav": sha256_file(wav), "project": sha256_file(project_path), "state": sha256_file(state_path)}
    facts = assert_project_wav(wav, load_expected_identity(expected_path_of(args)))
    assert_review_outside_project(review_dir, wav)
    meta = load_json(meta_path)
    if meta.get("audioSha256") != facts["sha256"]:
        raise SystemExit("BLOCKER=emissions_do_not_match_wav")
    if tokenizer.stat().st_size != TOKENIZER_BYTES:
        raise SystemExit("BLOCKER=tokenizer_size_mismatch")
    log_probs = np.load(npy)
    frame_sec = float(meta["frameSec"])
    project = load_json(project_path)
    state = load_json(state_path)
    units, empty = spoken_units(project)
    imported = (((state.get("externalNarration") or {}).get("imports") or {}).get("long") or {})
    joined = "\n".join(unit["text"].strip() for unit in units)
    aligned = align_known(log_probs.tolist(), frame_sec, units, tokenizer, facts["durationSec"])
    second = second_sentence_report(aligned["sentenceReview"])
    after = {"wav": sha256_file(wav), "project": sha256_file(project_path), "state": sha256_file(state_path)}
    if before != after:
        raise SystemExit("BLOCKER=source_files_changed_during_alignment")
    proposal = aligned["proposal"]
    transcript = transcript_block(log_probs.tolist(), aligned.get("blankId"), tokenizer, facts["sha256"], sha256_file(npy))
    write_reviews(review_dir, {
        "boundaries": {
            **transcript,
            "executionStatus": "alignment_files_written_listening_not_done",
            "saved": False,
            "timingsModified": False,
            "recordingModified": False,
            "renderStarted": False,
            "playFromHereVerified": False,
            "acousticVerification": False,
            "verified": False,
            "method": proposal["method"],
            "available": proposal["available"],
            "detail": proposal["detail"],
            "audioSha256": facts["sha256"],
            "audioDurationSec": facts["durationSec"],
            "frameSec": frame_sec,
            "extraction": meta.get("extraction"),
            "rows": proposal["rows"],
            "unresolved": proposal["unresolved"],
            "sentenceReview": aligned["sentenceReview"],
            "secondSentence": second,
            "emptyScenesNotEstimated": empty,
            "hardcodedStartUsed": False,
        },
        "diagnostics": {
            "listeningApproval": False,
            "pauseEstimationUsed": False,
            "silenceDetectorUsed": False,
            "identity": {"before": before, "after": after, "match": True},
            "importedScriptMatchesJoinedScenes": normalize_for_match(str(imported.get("scriptText") or "")) == normalize_for_match(joined),
            "blankId": aligned.get("blankId"),
            "spaceId": aligned.get("spaceId"),
            "tokenCount": aligned.get("tokenCount"),
            "savedStartsUnchanged": [{"sceneId": unit["sceneId"], "startTime": unit["savedStart"], "duration": unit["savedDuration"]} for unit in units],
            "secondSentence": second,
            "limits": [
                "Saved timings were not replaced.",
                "Play-from-here was not run because the project timeline was not changed.",
                "An earlier approximate listening note was not a target and was not applied as an offset.",
                "This file is not publication approval or a finished render.",
            ],
        },
        "listen": listen_text(aligned["sentenceReview"], second, facts["durationSec"]),
    })


def transcript_block(log_probs, blank_id, tokenizer_path: Path, audio_sha: str, emissions_sha: str) -> dict:
    """Greedy CTC transcript of THIS audio's emissions. Never reads the caption text.

    If the tokenizer exposes no decoder here, the transcript is reported unavailable
    (None) with the reason. Nothing is copied from the script in its place.
    """
    if blank_id is None:
        return {"transcript": None, "transcriptProvenance": None, "transcriptUnavailable": "The blank token id is unknown, so no transcript was produced."}
    try:
        import torch

        tokenizer, _pad, _specials = load_tokenizer(tokenizer_path)
        decoder = tokenizer.create_decoder()

        def decode_ids(ids):
            return str(decoder(torch.tensor(ids, dtype=torch.int64)))

        decoder_name = "fairseq2-char:create_decoder"
    except Exception as err:  # noqa: BLE001 - reported, never hidden
        return {
            "transcript": None,
            "transcriptProvenance": None,
            "transcriptUnavailable": f"The character decoder is unavailable on this runtime ({type(err).__name__}). No transcript was produced, and the script was not copied into its place.",
        }
    blank = int(blank_id)
    result = decode_transcript(log_probs, blank, decode_ids)
    return {
        "transcript": result["text"],
        "transcriptProvenance": transcript_provenance(
            audio_sha256=audio_sha,
            emissions_sha256=emissions_sha,
            frames=result["frames"],
            blank_id=blank,
            tokenizer_bytes=tokenizer_path.stat().st_size,
            decoder=decoder_name,
        ),
        "transcriptUnavailable": None,
    }


def run_alignment(args: argparse.Namespace) -> None:
    wav = Path(args.wav)
    project_path = Path(args.project_json)
    state_path = Path(args.state_json)
    checkpoint = Path(args.checkpoint)
    tokenizer = Path(args.tokenizer)
    review_dir = Path(args.review_dir)
    before = {
        "wav": sha256_file(wav),
        "project": sha256_file(project_path),
        "state": sha256_file(state_path),
    }
    facts = assert_project_wav(wav, load_expected_identity(expected_path_of(args)))
    assert_review_outside_project(review_dir, wav)
    if checkpoint.stat().st_size != CHECKPOINT_BYTES or tokenizer.stat().st_size != TOKENIZER_BYTES:
        raise SystemExit("BLOCKER=weight_size_mismatch")
    if checkpoint.read_bytes()[:2] != b"PK":
        raise SystemExit("BLOCKER=checkpoint_is_not_a_torch_zip")
    project = load_json(project_path)
    state = load_json(state_path)
    units, empty = spoken_units(project)
    imported = (((state.get("externalNarration") or {}).get("imports") or {}).get("long") or {})
    imported_text = str(imported.get("scriptText") or "")
    joined = "\n".join(unit["text"].strip() for unit in units)
    model = load_official_model(checkpoint)
    samples = resample_and_normalize(wav, facts["durationSec"])
    log_probs, frame_sec, extraction = extract_emissions(model, samples)
    if not math.isfinite(frame_sec) or frame_sec <= 0:
        raise SystemExit("BLOCKER=frame_duration_unknown")
    # Keep the emissions so a later transcript or re-alignment reuses them (validated by audio sha256).
    import numpy as np

    npy, meta_path = emissions_paths(review_dir)
    review_dir.mkdir(parents=True, exist_ok=True)
    np.save(npy, np.asarray(log_probs, dtype=np.float32))
    meta_path.write_text(json.dumps({
        "audioSha256": facts["sha256"],
        "frameSec": frame_sec,
        "frames": len(log_probs),
        "vocab": len(log_probs[0]) if log_probs else 0,
        "extraction": extraction,
        "officialWeightsUsed": True,
        "savedTimingsModified": False,
    }, indent=2) + "\n", encoding="utf-8")
    aligned = align_known(log_probs, frame_sec, units, tokenizer, facts["durationSec"])
    transcript = transcript_block(log_probs, aligned.get("blankId"), tokenizer, facts["sha256"], sha256_file(npy))
    second = second_sentence_report(aligned["sentenceReview"])
    after = {
        "wav": sha256_file(wav),
        "project": sha256_file(project_path),
        "state": sha256_file(state_path),
    }
    if before != after:
        raise SystemExit("BLOCKER=source_files_changed_during_alignment")
    proposal = aligned["proposal"]
    boundaries = {
        "executionStatus": "alignment_files_written_listening_not_done",
        "saved": False,
        "timingsModified": False,
        "recordingModified": False,
        "renderStarted": False,
        "playFromHereVerified": False,
        "acousticVerification": False,
        "verified": False,
        "method": proposal["method"],
        "available": proposal["available"],
        "detail": proposal["detail"],
        "audioSha256": facts["sha256"],
        "audioDurationSec": facts["durationSec"],
        "frameSec": frame_sec,
        "extraction": extraction,
        "rows": proposal["rows"],
        "unresolved": proposal["unresolved"],
        "sentenceReview": aligned["sentenceReview"],
        "secondSentence": second,
        "emptyScenesNotEstimated": empty,
        "hardcodedStartUsed": False,
        **transcript,
    }
    diagnostics = {
        "executionStatus": "prepared_code_ran_on_this_machine_only_if_this_file_exists",
        "listeningApproval": False,
        "pauseEstimationUsed": False,
        "silenceDetectorUsed": False,
        "weights": {
            "checkpoint": str(checkpoint),
            "checkpointBytes": checkpoint.stat().st_size,
            "tokenizer": str(tokenizer),
            "tokenizerBytes": tokenizer.stat().st_size,
            "license": "Apache-2.0",
            "modelCard": "omniASR_CTC_300M_v2",
        },
        "identity": {"before": before, "after": after, "match": True},
        "importedScriptMatchesJoinedScenes": normalize_for_match(imported_text) == normalize_for_match(joined),
        "blankId": aligned.get("blankId"),
        "spaceId": aligned.get("spaceId"),
        "tokenCount": aligned.get("tokenCount"),
        "savedStartsUnchanged": [{"sceneId": unit["sceneId"], "startTime": unit["savedStart"], "duration": unit["savedDuration"]} for unit in units],
        "secondSentence": second,
        "limits": [
            "Saved timings were not replaced.",
            "Play-from-here was not run because the project timeline was not changed.",
            "An earlier approximate listening note was not a target and was not applied as an offset.",
            "This file is not publication approval or a finished render.",
        ],
    }
    write_reviews(review_dir, {
        "boundaries": boundaries,
        "diagnostics": diagnostics,
        "listen": listen_text(aligned["sentenceReview"], second, facts["durationSec"]),
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test-forward", action="store_true")
    parser.add_argument("--extract-only", action="store_true")
    parser.add_argument("--align-only", action="store_true")
    parser.add_argument("--wav")
    parser.add_argument("--project-json")
    parser.add_argument("--state-json")
    parser.add_argument("--checkpoint")
    parser.add_argument("--tokenizer")
    parser.add_argument("--review-dir")
    parser.add_argument("--expected-audio-json")
    args = parser.parse_args()
    try:
        if args.self_test_forward:
            self_test_forward()
            return
        if args.extract_only:
            if not all((args.wav, args.checkpoint, args.review_dir, args.expected_audio_json)):
                raise SystemExit("BLOCKER=extract_arguments_missing")
            extract_only(args)
            return
        if args.align_only:
            required = (args.wav, args.project_json, args.state_json, args.tokenizer, args.review_dir, args.expected_audio_json)
            if not all(required):
                raise SystemExit("BLOCKER=align_arguments_missing")
            align_from_emissions(args)
            return
        required = (args.wav, args.project_json, args.state_json, args.checkpoint, args.tokenizer, args.review_dir, args.expected_audio_json)
        if not all(required):
            raise SystemExit("BLOCKER=alignment_arguments_missing")
        run_alignment(args)
    except SystemExit:
        raise
    except Exception:
        traceback.print_exc()
        raise SystemExit("BLOCKER=alignment_exception")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    main()
