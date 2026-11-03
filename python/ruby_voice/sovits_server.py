"""Ruby's voice server, backed by the fine-tuned GPT-SoVITS v2Pro model.

Exposes the same HTTP contract as tts_server.py (the XTTS version), so the Node
backend works against either one without changes:

    GET  /health           -> {"status": "ok", "device": "cuda", ...}
    POST /tts {"text": ""} -> audio/wav

The engine's dependencies live in the GPT-SoVITS virtual environment, not this
folder's. Launching with any other interpreter used to fail with confusing
errors such as "No module named 'jieba'", so the script now re-launches itself
under the right one. Either of these works:

    python sovits_server.py
    ..\\gpt_sovits\\.venv\\Scripts\\python.exe sovits_server.py

GPT-SoVITS is MIT licensed, so unlike XTTS there is no non-commercial
restriction on the model code.
"""
import argparse
import io
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# Upstream prints Chinese status messages at import time, which crash on a
# Windows cp1252 console with UnicodeEncodeError.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

RUBY_DIR = Path(__file__).resolve().parent
REPO = RUBY_DIR.parent / "gpt_sovits"
_WINDOWS_PYTHON = REPO / ".venv" / "Scripts" / "python.exe"
_POSIX_PYTHON = REPO / ".venv" / "bin" / "python"
ENGINE_PYTHON = _WINDOWS_PYTHON if _WINDOWS_PYTHON.exists() else _POSIX_PYTHON
_REEXEC_FLAG = "RUBY_VOICE_REEXEC"


def relaunch_under_engine_venv() -> None:
    """Re-run this script with the GPT-SoVITS interpreter when needed.

    GPT-SoVITS pins numpy<2 and transformers<5, which conflict with the XTTS
    and Whisper tooling in this folder's own venv, so the two environments are
    kept separate and cannot be merged. Rather than make that a trap, detect
    the wrong interpreter and switch to the right one.
    """
    if os.environ.get(_REEXEC_FLAG) == "1":
        return  # already relaunched; never loop
    if not ENGINE_PYTHON.exists():
        raise SystemExit(
            f"GPT-SoVITS environment not found at {ENGINE_PYTHON}.\n"
            "See python/ruby_voice/README.md for how to create it."
        )
    if Path(sys.executable).resolve() == ENGINE_PYTHON.resolve():
        return  # already the right interpreter

    environment = {**os.environ, _REEXEC_FLAG: "1", "PYTHONIOENCODING": "utf-8"}
    print(f"Relaunching under the GPT-SoVITS environment:\n  {ENGINE_PYTHON}\n", flush=True)
    completed = subprocess.run(
        [str(ENGINE_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]],
        env=environment,
    )
    raise SystemExit(completed.returncode)


relaunch_under_engine_venv()

# Imported after the interpreter check: it needs numpy, and before the engine
# chdir's away from this directory.
import reverb  # noqa: E402

HOST = "127.0.0.1"  # local only; the Node backend proxies requests
DEFAULT_PORT = 5055
MAX_TEXT_LENGTH = 600

DATASET_LIST = RUBY_DIR / "dataset" / "ruby.list"
SOVITS_WEIGHTS = REPO / "SoVITS_weights_v2Pro" / "ruby_e8_s384.pth"
GPT_WEIGHTS = REPO / "GPT_weights_v2Pro" / "ruby-e15.ckpt"
# GPT-SoVITS copies tone from this clip at inference time, and upstream rejects
# anything outside 3-10 s. The choice matters more than any other inference
# knob: sweeping all 16 training clips on one sentence scored 0.57 to 0.78 for
# speaker similarity, and this clip won.
DEFAULT_REFERENCE = "ruby_01_002.wav"


def load_reference(reference_name: str) -> tuple[str, str]:
    """Return (wav_path, transcript) for a clip in the training manifest."""
    for line in DATASET_LIST.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        wav_path, _speaker, _language, text = line.split("|", 3)
        if Path(wav_path).name == reference_name:
            return wav_path, text
    raise SystemExit(f"Reference clip {reference_name} not found in {DATASET_LIST}")


class RubyVoice:
    def __init__(self, reference_name: str, reverb_wet: float, reverb_rt60: float,
                 room_tone_db: float | None) -> None:
        if not SOVITS_WEIGHTS.exists() or not GPT_WEIGHTS.exists():
            raise SystemExit("Fine-tuned weights missing. Run train_ruby.py first.")

        self.reverb_wet = reverb_wet
        self.reverb_rt60 = reverb_rt60
        self.room_tone_db = room_tone_db
        self.reference_wav, self.reference_text = load_reference(reference_name)

        # inference_webui reads all of this from the environment at import time.
        os.environ["version"] = "v2Pro"
        os.environ["sovits_path"] = str(SOVITS_WEIGHTS)
        os.environ["gpt_path"] = str(GPT_WEIGHTS)
        os.environ["bert_path"] = "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large"
        os.environ["cnhubert_base_path"] = "GPT_SoVITS/pretrained_models/chinese-hubert-base"
        os.environ["is_half"] = "True"

        # Its module-level code resolves model paths relative to the repo root.
        os.chdir(REPO)
        sys.path.insert(0, str(REPO))
        sys.path.insert(0, str(REPO / "GPT_SoVITS"))
        # Supplies the jieba_fast alias that the eagerly-imported Chinese text
        # frontend needs; see compat/jieba_fast/__init__.py.
        sys.path.insert(0, str(RUBY_DIR / "compat"))

        import torch
        from tools.i18n.i18n import I18nAuto

        print("Loading Ruby's fine-tuned GPT-SoVITS model ...", flush=True)
        from GPT_SoVITS import inference_webui as engine

        self.engine = engine
        self.i18n = I18nAuto()
        self.device = "cuda" if torch.cuda.is_available() else "cpu"

        engine.change_sovits_weights(str(SOVITS_WEIGHTS))
        engine.change_gpt_weights(str(GPT_WEIGHTS))
        self.lock = threading.Lock()  # one GPU synthesis at a time
        print(f"Reference clip: {Path(self.reference_wav).name}", flush=True)

    def synthesize(self, text: str) -> bytes:
        import numpy as np
        import soundfile as sf

        with self.lock:
            chunks = list(
                self.engine.get_tts_wav(
                    ref_wav_path=self.reference_wav,
                    prompt_text=self.reference_text,
                    prompt_language=self.i18n("英文"),  # dict_language key for English
                    text=text,
                    text_language=self.i18n("英文"),
                    how_to_cut=self.i18n("按标点符号切"),  # split on punctuation
                    top_k=15,
                    top_p=1.0,
                    temperature=1.0,
                    speed=1.0,
                )
            )
        if not chunks:
            raise RuntimeError("Synthesis produced no audio")

        sample_rate = chunks[-1][0]
        audio = np.concatenate([np.asarray(chunk[1]).reshape(-1) for chunk in chunks])

        # The engine yields int16 samples. Convert to float in -1..1 before any
        # processing: soundfile interprets float input on that scale, so writing
        # int-scaled floats would clip every sample to full scale.
        if np.issubdtype(audio.dtype, np.integer):
            audio = audio.astype(np.float32) / 32768.0
        else:
            audio = audio.astype(np.float32)

        # The model output is effectively dry, while Ruby's source recordings
        # carry a small room tail and a steady noise floor. Adding them back
        # closes most of the remaining audible gap.
        if self.reverb_wet > 0 or self.room_tone_db is not None:
            peak = float(np.max(np.abs(audio))) or 1.0
            processed = audio / peak  # effects are tuned against unit-peak audio
            if self.reverb_wet > 0:
                processed = reverb.apply_reverb(
                    processed, sample_rate, rt60=self.reverb_rt60, wet=self.reverb_wet
                )
            if self.room_tone_db is not None:
                processed = reverb.add_room_tone(
                    processed, sample_rate, db_below_speech=self.room_tone_db
                )
            audio = processed * peak  # restore original loudness, still within -1..1

        buffer = io.BytesIO()
        sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
        return buffer.getvalue()


def make_handler(voice: RubyVoice):
    class Handler(BaseHTTPRequestHandler):
        def _json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path == "/health":
                return self._json(200, {
                    "status": "ok",
                    "device": voice.device,
                    "model": "gpt-sovits-v2Pro-ruby",
                })
            return self._json(404, {"error": "Not found"})

        def do_POST(self):  # noqa: N802
            if self.path != "/tts":
                return self._json(404, {"error": "Not found"})
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0 or length > 10_000:
                    raise ValueError("Invalid body size")
                text = json.loads(self.rfile.read(length)).get("text", "")
                if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_LENGTH:
                    raise ValueError("Invalid text")
            except (ValueError, json.JSONDecodeError):
                return self._json(400, {"error": f"Send JSON {{\"text\": ...}} up to {MAX_TEXT_LENGTH} chars."})

            try:
                started = time.perf_counter()
                audio = voice.synthesize(text.strip())
                print(f"Synthesised {len(text)} chars in {time.perf_counter() - started:.1f} s", flush=True)
            except Exception as error:  # surface model errors without killing the server
                print(f"Synthesis failed: {error}", flush=True)
                return self._json(500, {"error": "Synthesis failed"})

            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(audio)))
            self.end_headers()
            self.wfile.write(audio)

        def log_message(self, *_args):  # keep the console quiet
            pass

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description="Ruby GPT-SoVITS voice server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--reference", default=DEFAULT_REFERENCE,
                        help="Training clip used as the tone reference")
    parser.add_argument("--reverb-wet", type=float, default=reverb.DEFAULT_WET,
                        help="Reverb amount; 0 disables it")
    parser.add_argument("--reverb-rt60", type=float, default=reverb.DEFAULT_RT60,
                        help="Reverb decay time in seconds")
    # Room tone is off unless asked for: it reproduces the source recordings'
    # noise floor, but at an audible level it simply sounds like hiss.
    parser.add_argument("--room-tone-db", type=float, default=None,
                        metavar="DB",
                        help="Optional steady noise floor this many dB below speech "
                             f"(try {reverb.DEFAULT_ROOM_TONE_DB:g}); omitted means silent pauses")
    args = parser.parse_args()

    room_tone_db = args.room_tone_db
    voice = RubyVoice(args.reference, args.reverb_wet, args.reverb_rt60, room_tone_db)
    print(
        f"Reverb: wet={args.reverb_wet} rt60={args.reverb_rt60}s | "
        f"room tone: {'off' if room_tone_db is None else f'-{room_tone_db:g} dB'}",
        flush=True,
    )
    server = ThreadingHTTPServer((HOST, args.port), make_handler(voice))
    print(f"Ruby voice server ready at http://{HOST}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
