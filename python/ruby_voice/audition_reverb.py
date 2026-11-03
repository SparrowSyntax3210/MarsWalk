"""Render Ruby's existing samples at several reverb levels so you can choose.

Reverb amount is a judgement call that only listening can settle, so this
applies a range of settings to already-generated audio (no re-synthesis) and
writes them side by side for comparison.

Usage:
    .venv\\Scripts\\python.exe audition_reverb.py

Listen to samples_reverb/, pick the level you prefer, then set it as the
default via DEFAULT_WET in reverb.py, or pass --reverb-wet to sovits_server.py.
"""
import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

import reverb

RUBY_DIR = Path(__file__).resolve().parent
INPUT_DIR = RUBY_DIR / "samples_final"
OUTPUT_DIR = RUBY_DIR / "samples_reverb"

# rt60 is fixed at the value measured from Ruby's source clips (decay of about
# 86 dB/s, so RT60 near 0.7 s); only the amount varies here.
# (label, wet, room tone in dB below speech or None for no room tone)
LEVELS = [
    ("00_dry", 0.0, None),
    ("01_subtle", 0.14, None),
    ("02_light", 0.20, None),
    ("03_medium", 0.26, None),
    ("04_strong", 0.34, None),
    # Optional steady noise floor. It matches the source recordings but reads
    # as hiss, so it is off by default; these are here only to audition.
    ("05_medium_plus_faint_roomtone", 0.26, 34.0),
    ("06_medium_plus_roomtone", 0.26, 25.0),
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rt60", type=float, default=reverb.DEFAULT_RT60)
    args = parser.parse_args()

    sources = sorted(INPUT_DIR.glob("*.wav"))
    if not sources:
        raise SystemExit(f"No samples in {INPUT_DIR}. Generate some replies first.")

    OUTPUT_DIR.mkdir(exist_ok=True)
    for stale in OUTPUT_DIR.glob("*.wav"):
        stale.unlink()

    for source in sources:
        audio, rate = sf.read(source)
        audio = audio if audio.ndim == 1 else audio.mean(axis=1)
        peak = float(np.max(np.abs(audio))) or 1.0
        for label, wet, room_tone_db in LEVELS:
            processed = audio / peak
            if wet > 0:
                processed = reverb.apply_reverb(processed, rate, rt60=args.rt60, wet=wet)
            if room_tone_db is not None:
                processed = reverb.add_room_tone(processed, rate, db_below_speech=room_tone_db)
            target = OUTPUT_DIR / f"{source.stem}__{label}.wav"
            sf.write(target, processed * peak, rate, subtype="PCM_16")

    print(f"Wrote {len(sources) * len(LEVELS)} files to {OUTPUT_DIR}")
    print("Compare one sentence across levels, for example:")
    stem = sources[0].stem
    for label, wet, room_tone_db in LEVELS:
        tone = "none" if room_tone_db is None else f"-{room_tone_db:g} dB"
        print(f"   {stem}__{label}.wav   (wet={wet}, room tone {tone})")


if __name__ == "__main__":
    main()
