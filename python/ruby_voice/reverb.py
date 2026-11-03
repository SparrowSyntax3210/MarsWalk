"""Small room reverb for Ruby's synthesized speech.

Ruby's source recordings were made in a modestly reverberant room: measured
energy decay is about 86 dB/s (RT60 around 0.7 s), pauses sit near 37 dB below
speech level, and only 3-5% of frames are near-silent because the tail fills
the gaps between words. The fine-tuned model reproduces her timbre but outputs
an effectively dry signal whose pauses fall to digital silence, which is the
main remaining audible difference.

This applies convolution reverb using a synthetic impulse response: noise
shaped by an exponential decay envelope, with the high end damped so it decays
faster than the low end, as in a real room. The impulse response is normalised
to unit energy so `wet` alone controls how much tail is added, and it is
generated from a fixed seed so output stays reproducible.
"""
from __future__ import annotations

import numpy as np

# Defaults chosen to reproduce the measured decay of the source clips; see
# tune_reverb in the project history for how wet was selected.
DEFAULT_RT60 = 0.70       # seconds to decay 60 dB
DEFAULT_WET = 0.26        # linear gain applied to the unit-energy wet signal
DEFAULT_PREDELAY_MS = 18.0
DEFAULT_DAMPING = 0.34    # 0 = bright tail, ->1 = heavily damped tail

_DB60 = np.log(1000.0)  # ln(10^3): amplitude factor for -60 dB


def build_impulse_response(
    rate: int,
    rt60: float = DEFAULT_RT60,
    predelay_ms: float = DEFAULT_PREDELAY_MS,
    damping: float = DEFAULT_DAMPING,
    seed: int = 20260101,
) -> np.ndarray:
    """Build a unit-energy synthetic room impulse response."""
    if rt60 <= 0:
        raise ValueError("rt60 must be positive")
    if not 0.0 <= damping < 1.0:
        raise ValueError("damping must be in [0, 1)")

    tail_length = max(1, int(rt60 * 1.5 * rate))
    time = np.arange(tail_length) / rate
    noise = np.random.default_rng(seed).standard_normal(tail_length)

    # One-pole lowpass: rolls off the tail's high end so it decays faster than
    # the low end, which is how real rooms behave.
    if damping > 0:
        filtered = np.empty_like(noise)
        state = 0.0
        for index, sample in enumerate(noise):
            state = damping * state + (1.0 - damping) * sample
            filtered[index] = state
        noise = filtered

    impulse = noise * np.exp(-time * _DB60 / rt60)

    predelay = max(0, int(predelay_ms / 1000.0 * rate))
    if predelay:
        impulse = np.concatenate([np.zeros(predelay, dtype=impulse.dtype), impulse])

    energy = float(np.sqrt(np.sum(impulse**2)))
    return (impulse / energy).astype(np.float32) if energy else impulse.astype(np.float32)


def apply_reverb(
    audio: np.ndarray,
    rate: int,
    rt60: float = DEFAULT_RT60,
    wet: float = DEFAULT_WET,
    predelay_ms: float = DEFAULT_PREDELAY_MS,
    damping: float = DEFAULT_DAMPING,
) -> np.ndarray:
    """Mix a reverb tail into mono audio, preserving its original peak level.

    `wet` of 0 returns the input unchanged.
    """
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    if wet <= 0 or audio.size == 0:
        return audio

    impulse = build_impulse_response(rate, rt60, predelay_ms, damping)
    try:
        from scipy.signal import fftconvolve

        tail = fftconvolve(audio, impulse, mode="full")
    except ImportError:  # pragma: no cover - scipy ships with the voice venvs
        tail = np.convolve(audio, impulse, mode="full")

    # Keep the dry signal full length and let the tail ring on past the end.
    padded = np.zeros(tail.size, dtype=np.float32)
    padded[: audio.size] = audio
    mixed = padded + wet * tail.astype(np.float32)

    # Match the input peak so downstream level handling is unaffected.
    source_peak = float(np.max(np.abs(audio)))
    mixed_peak = float(np.max(np.abs(mixed)))
    if mixed_peak > 0 and source_peak > 0:
        mixed *= source_peak / mixed_peak
    return mixed


# Ruby's source clips also carry a steady broadband floor about 25 dB below
# speech level (measured SNR of roughly 22 dB), which reverb cannot reproduce:
# a reverb tail decays between words, whereas this floor is constant. Adding it
# back is what makes output sound recorded rather than synthesized.
# Off by default: at any audible level this reads as hiss, because a steady
# broadband floor is far more noticeable than the measurement suggests. Enable
# it only if you want Ruby to sound like a room recording.
DEFAULT_ROOM_TONE_DB = 34.0  # dB below speech level; higher value = quieter
ROOM_TONE_LOWPASS = 0.55     # one-pole coefficient, applied repeatedly
# Ruby's clips carry almost no energy above 10 kHz, so a single gentle rolloff
# still left the noise 3-4x brighter than the source and clearly audible.
# Cascading the filter steepens the slope and keeps the tone under the voice.
ROOM_TONE_PASSES = 4


def add_room_tone(
    audio: np.ndarray,
    rate: int,
    db_below_speech: float = DEFAULT_ROOM_TONE_DB,
    seed: int = 20260102,
) -> np.ndarray:
    """Mix a steady, gently lowpassed noise floor under mono audio.

    The level is set relative to the signal's own speech level (90th percentile
    of short-term RMS) so it tracks loudness rather than peak transients.
    """
    audio = np.asarray(audio, dtype=np.float32).reshape(-1)
    if audio.size == 0 or db_below_speech >= 120:
        return audio

    frame = max(1, int(0.01 * rate))
    frames = audio[: audio.size // frame * frame].reshape(-1, frame)
    if frames.size == 0:
        return audio
    speech_rms = float(np.percentile(np.sqrt((frames.astype(np.float64) ** 2).mean(axis=1)), 90))
    if speech_rms <= 0:
        return audio

    noise = np.random.default_rng(seed).standard_normal(audio.size)
    for _ in range(ROOM_TONE_PASSES):
        state = 0.0
        for index, sample in enumerate(noise):
            state = ROOM_TONE_LOWPASS * state + (1.0 - ROOM_TONE_LOWPASS) * sample
            noise[index] = state
    noise_rms = float(np.sqrt((noise**2).mean())) or 1.0
    target_rms = speech_rms * (10.0 ** (-db_below_speech / 20.0))

    mixed = audio + (noise * (target_rms / noise_rms)).astype(np.float32)
    peak = float(np.max(np.abs(mixed)))
    if peak > 1.0:  # keep headroom before 16-bit conversion
        mixed /= peak
    return mixed
