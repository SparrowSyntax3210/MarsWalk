"""Convert Ruby's AAC voice samples into clean mono WAV references for XTTS-v2.

Usage:
    .venv\\Scripts\\python.exe prepare_voice.py            # isolate vocals (default)
    .venv\\Scripts\\python.exe prepare_voice.py --raw      # skip vocal isolation

Reads every *.aac file whose name starts with "AI voice" in
frontend/public/assets. By default the voice is separated from background
noise/music with Demucs (htdemucs) on the GPU, because voice cloning copies
any background sound in the reference. Writes 22.05 kHz mono WAVs to voice_refs/.
"""
import argparse
from pathlib import Path

import av
import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
SOURCE_DIR = ROOT / "frontend" / "public" / "assets"
OUTPUT_DIR = Path(__file__).resolve().parent / "voice_refs"
DEMUCS_RATE = 44_100
TARGET_RATE = 22_050
SILENCE_THRESHOLD = 0.01  # fraction of full scale


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


class VocalIsolator:
    """Demucs htdemucs wrapper: returns only the 'vocals' stem."""

    def __init__(self) -> None:
        import torch
        from demucs.pretrained import get_model

        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = get_model("htdemucs").to(self.device).eval()
        self.vocals_index = self.model.sources.index("vocals")

    def __call__(self, mono_44k: np.ndarray) -> np.ndarray:
        import torchaudio.functional as AF
        from demucs.apply import apply_model

        torch = self.torch
        wav = torch.from_numpy(mono_44k).repeat(2, 1)  # model expects stereo
        mean, std = wav.mean(), wav.std() + 1e-8
        with torch.no_grad():
            stems = apply_model(self.model, ((wav - mean) / std)[None], device=self.device,
                                split=True, overlap=0.25, progress=False)[0]
        vocals = (stems[self.vocals_index] * std + mean).mean(0)
        return AF.resample(vocals.cpu(), DEMUCS_RATE, TARGET_RATE).numpy().astype(np.float32)


def trim_and_normalise(audio: np.ndarray) -> np.ndarray:
    """Trim leading/trailing silence and peak-normalise to -1 dBFS."""
    loud = np.flatnonzero(np.abs(audio) > SILENCE_THRESHOLD)
    if loud.size:
        pad = int(0.1 * TARGET_RATE)
        audio = audio[max(loud[0] - pad, 0): loud[-1] + pad]
    peak = float(np.max(np.abs(audio))) or 1.0
    return audio * (0.89 / peak)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--raw", action="store_true", help="skip Demucs vocal isolation")
    args = parser.parse_args()

    sources = sorted(SOURCE_DIR.glob("AI voice*.aac"))
    if not sources:
        raise SystemExit(f"No 'AI voice*.aac' files found in {SOURCE_DIR}")

    isolate = None if args.raw else VocalIsolator()
    OUTPUT_DIR.mkdir(exist_ok=True)
    for index, source in enumerate(sources, start=1):
        if isolate:
            audio = isolate(decode_to_mono(source, DEMUCS_RATE))
        else:
            audio = decode_to_mono(source, TARGET_RATE)
        audio = trim_and_normalise(audio)
        target = OUTPUT_DIR / f"ruby_ref_{index}.wav"
        sf.write(target, audio, TARGET_RATE, subtype="PCM_16")
        mode = "vocals isolated" if isolate else "raw"
        print(f"{source.name} -> {target.name} ({len(audio) / TARGET_RATE:.1f} s, {mode})")


if __name__ == "__main__":
    main()
