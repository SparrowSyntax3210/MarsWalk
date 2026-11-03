"""Build a GPT-SoVITS training dataset from Ruby's AAC voice samples.

Runs in the ruby_voice venv (it has whisper + av + soundfile) and writes plain
WAV files plus a .list manifest that the GPT-SoVITS venv consumes.

Usage:
    .venv\\Scripts\\python.exe build_dataset.py [--model medium]

Why raw audio and not the Demucs-separated vocals: Demucs measured these clips
as 99.7% vocals, so there is effectively no background to remove and running
separation would only risk adding artifacts to the training set.

Whisper gives segment timestamps and text together, so slicing on its segment
boundaries yields audio/text pairs that are aligned by construction.
"""
import argparse
import warnings
from pathlib import Path

import av
import numpy as np
import soundfile as sf

warnings.filterwarnings("ignore")

ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "frontend" / "public" / "assets"
DATASET_DIR = Path(__file__).resolve().parent / "dataset"
WAV_DIR = DATASET_DIR / "wavs"
LIST_PATH = DATASET_DIR / "ruby.list"
SPEAKER = "Ruby"
LANGUAGE = "en"

TARGET_RATE = 32_000  # GPT-SoVITS v2 series trains at 32 kHz
MIN_SECONDS = 2.0     # shorter clips carry too little prosody
MAX_SECONDS = 12.0    # longer clips raise VRAM use during training
EDGE_PAD_SECONDS = 0.08
# Whisper reports no_speech_prob per 30 s window, not per segment, so every
# segment in a window shares one value. Keep this loose: on Ruby's clips, clear
# speech scored up to 0.44 and a tighter bound silently discarded a third of
# the usable audio.
MAX_NO_SPEECH_PROB = 0.6
PEAK_TARGET = 0.89


def decode_to_mono(path: Path, rate: int) -> np.ndarray:
    """Decode any ffmpeg-readable audio file to float32 mono at `rate`."""
    resampler = av.AudioResampler(format="flt", layout="mono", rate=rate)
    chunks = []
    with av.open(str(path)) as container:
        for frame in container.decode(audio=0):
            for resampled in resampler.resample(frame):
                chunks.append(resampled.to_ndarray().reshape(-1))
        for resampled in resampler.resample(None):  # flush
            chunks.append(resampled.to_ndarray().reshape(-1))
    if not chunks:
        raise ValueError(f"No audio decoded from {path.name}")
    return np.concatenate(chunks).astype(np.float32)


def split_segment(segment: dict) -> list[tuple[float, float, str]]:
    """Split a Whisper segment into pieces no longer than MAX_SECONDS.

    Long segments are broken on word boundaries (preferring sentence-ending
    punctuation) instead of being discarded, so none of the limited training
    audio is wasted.
    """
    start, end = segment["start"], segment["end"]
    text = segment["text"].strip()
    if end - start <= MAX_SECONDS:
        return [(start, end, text)]

    words = [w for w in segment.get("words") or [] if w.get("word", "").strip()]
    if not words:
        return []  # cannot split safely without word timings

    pieces: list[tuple[float, float, str]] = []
    current: list[dict] = []
    for word in words:
        current.append(word)
        span = word["end"] - current[0]["start"]
        ends_sentence = word["word"].strip().endswith((".", "!", "?"))
        # Close the piece at a sentence end past the halfway mark, or whenever
        # adding more words would exceed the cap.
        if (ends_sentence and span >= MAX_SECONDS / 2) or span >= MAX_SECONDS * 0.9:
            pieces.append(current)
            current = []
    if current:
        pieces.append(current)

    # Merge a too-short trailing piece back into its predecessor when the
    # combined span still fits.
    if len(pieces) >= 2:
        tail_span = pieces[-1][-1]["end"] - pieces[-1][0]["start"]
        merged_span = pieces[-1][-1]["end"] - pieces[-2][0]["start"]
        if tail_span < MIN_SECONDS and merged_span <= MAX_SECONDS:
            pieces[-2].extend(pieces.pop())

    return [
        (p[0]["start"], p[-1]["end"], " ".join(w["word"].strip() for w in p).strip())
        for p in pieces
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="medium", help="Whisper model size (default: medium)")
    args = parser.parse_args()

    sources = sorted(SOURCE_DIR.glob("AI voice*.aac"))
    if not sources:
        raise SystemExit(f"No 'AI voice*.aac' files found in {SOURCE_DIR}")

    import torch
    import whisper

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Loading Whisper '{args.model}' on {device} ...", flush=True)
    model = whisper.load_model(args.model, device=device)

    WAV_DIR.mkdir(parents=True, exist_ok=True)
    for stale in WAV_DIR.glob("*.wav"):
        stale.unlink()

    rows = []
    kept_seconds = 0.0
    for source_index, source in enumerate(sources, start=1):
        audio = decode_to_mono(source, TARGET_RATE)
        # Whisper needs 16 kHz; transcribe from a resampled copy but slice the
        # full-rate audio so the training set keeps its original quality.
        audio16 = decode_to_mono(source, 16_000)
        result = model.transcribe(audio16, language="en", word_timestamps=True, verbose=False)

        piece_index = 0
        for segment in result["segments"]:
            if segment.get("no_speech_prob", 0.0) > MAX_NO_SPEECH_PROB or not segment["text"].strip():
                continue

            for piece_start, piece_end, text in split_segment(segment):
                duration = piece_end - piece_start
                if duration < MIN_SECONDS or not text:
                    print(f"   skip {duration:.1f}s piece: {text[:40]!r}")
                    continue

                start = max(0, int((piece_start - EDGE_PAD_SECONDS) * TARGET_RATE))
                end = min(len(audio), int((piece_end + EDGE_PAD_SECONDS) * TARGET_RATE))
                clip = audio[start:end]
                peak = float(np.max(np.abs(clip))) or 1.0
                clip = clip * (PEAK_TARGET / peak)

                piece_index += 1
                wav_path = WAV_DIR / f"ruby_{source_index:02d}_{piece_index:03d}.wav"
                sf.write(wav_path, clip, TARGET_RATE, subtype="PCM_16")
                rows.append(f"{wav_path.resolve()}|{SPEAKER}|{LANGUAGE}|{text}")
                kept_seconds += len(clip) / TARGET_RATE

    if not rows:
        raise SystemExit("No usable segments were produced.")

    LIST_PATH.write_text("\n".join(rows) + "\n", encoding="utf-8")
    print(f"\nWrote {len(rows)} segments ({kept_seconds:.1f}s total) to {LIST_PATH}")
    print(f"Audio: {WAV_DIR}")


if __name__ == "__main__":
    main()
