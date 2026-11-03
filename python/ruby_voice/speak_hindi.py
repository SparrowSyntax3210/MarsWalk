"""Speak Hindi in Ruby's voice, for auditioning only.

Hindi has to go through XTTS-v2 rather than Ruby's fine-tuned GPT-SoVITS
model: GPT-SoVITS v2Pro has no Hindi text frontend, and feeding romanized
Hindi to its English phonemizer produces an accent so heavy that Whisper
does not recognise the result as Hindi.

XTTS clones zero-shot from Ruby's reference clips instead of being fine-tuned,
so expect a slightly looser voice match than the English model. XTTS-v2 is also
released under the Coqui Public Model License, which is non-commercial.

Usage:
    # Write the built-in sample set to samples_hindi/
    .venv\\Scripts\\python.exe speak_hindi.py

    # Or try your own line
    .venv\\Scripts\\python.exe speak_hindi.py --text "मंगल पर आपका स्वागत है।" --name welcome

The GPT-SoVITS voice server holds most of the 4 GB GPU, so stop it first or
pass --cpu.

Note this needs THIS folder's venv (XTTS lives here), unlike sovits_server.py
which needs the GPT-SoVITS one. The script sorts that out itself.
"""
import argparse
import os
import subprocess
import sys
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
os.environ.setdefault("COQUI_TOS_AGREED", "1")

RUBY_DIR = Path(__file__).resolve().parent
_WINDOWS_PYTHON = RUBY_DIR / ".venv" / "Scripts" / "python.exe"
_POSIX_PYTHON = RUBY_DIR / ".venv" / "bin" / "python"
XTTS_PYTHON = _WINDOWS_PYTHON if _WINDOWS_PYTHON.exists() else _POSIX_PYTHON
_REEXEC_FLAG = "RUBY_HINDI_REEXEC"


def relaunch_under_xtts_venv() -> None:
    """Re-run this script with the venv that has XTTS installed."""
    if os.environ.get(_REEXEC_FLAG) == "1":
        return  # already relaunched; never loop
    if not XTTS_PYTHON.exists():
        raise SystemExit(
            f"Voice environment not found at {XTTS_PYTHON}.\n"
            "See python/ruby_voice/README.md for how to create it."
        )
    if Path(sys.executable).resolve() == XTTS_PYTHON.resolve():
        return

    environment = {**os.environ, _REEXEC_FLAG: "1", "PYTHONIOENCODING": "utf-8"}
    print(f"Relaunching under:\n  {XTTS_PYTHON}\n", flush=True)
    completed = subprocess.run(
        [str(XTTS_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]],
        env=environment,
    )
    raise SystemExit(completed.returncode)


relaunch_under_xtts_venv()

OUTPUT_DIR = RUBY_DIR / "samples_hindi"
REFERENCE_DIR = RUBY_DIR / "voice_refs"

# Lines Ruby would plausibly say, to judge the voice across different content.
SAMPLE_LINES = {
    "greeting": "नमस्ते, मैं रूबी हूँ, आपकी मार्सवॉक मिशन गाइड। "
                "मुझसे मंगल ग्रह के बारे में कुछ भी पूछिए।",
    "elevation": "जेज़ीरो क्रेटर की ऊंचाई मार्स डेटम से लगभग "
                 "दो हज़ार छह सौ चौवालीस मीटर नीचे है।",
    "gravity": "मंगल पर गुरुत्वाकर्षण लगभग तीन दशमलव सात मीटर प्रति सेकंड स्क्वायर है। "
               "यह पृथ्वी का सिर्फ अड़तीस प्रतिशत है।",
    "navigation": "अगले पांच सौ मीटर तक सीधे चलते रहिए, "
                  "फिर दाईं ओर मुड़कर घाटी के किनारे से आगे बढ़िए।",
    "warning": "सावधान रहिए। आगे ढलान बहुत तेज़ है और धूल भरी आंधी आ रही है। "
               "कृपया अपना रास्ता बदलिए।",
    "long": "मंगल ग्रह पर एक दिन को सोल कहते हैं, जो चौबीस घंटे "
            "उनतालीस मिनट का होता है। यहाँ का वातावरण ज़्यादातर कार्बन डाइऑक्साइड "
            "से बना है, इसलिए बाहर निकलने के लिए स्पेस सूट ज़रूरी है।",
}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--text", help="Hindi text to speak (Devanagari)")
    parser.add_argument("--name", default="custom", help="Output file name stem")
    parser.add_argument("--cpu", action="store_true", help="Run on CPU instead of the GPU")
    parser.add_argument("--no-reverb", action="store_true", help="Skip the room tail")
    args = parser.parse_args()

    import soundfile as sf
    import torch
    from TTS.api import TTS

    import reverb

    references = sorted(str(p) for p in REFERENCE_DIR.glob("*.wav"))
    if not references:
        raise SystemExit(f"No reference clips in {REFERENCE_DIR}. Run prepare_voice.py first.")

    device = "cpu" if args.cpu else ("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Loading XTTS-v2 on {device} ...", flush=True)
    model = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device).synthesizer.tts_model
    rate = model.config.audio.output_sample_rate

    # 12 s of conditioning audio scored best when this was tuned for English.
    latent, embedding = model.get_conditioning_latents(
        audio_path=references, max_ref_length=60, gpt_cond_len=12, gpt_cond_chunk_len=4
    )

    lines = {args.name: args.text} if args.text else SAMPLE_LINES
    OUTPUT_DIR.mkdir(exist_ok=True)

    for name, text in lines.items():
        torch.manual_seed(0)  # reproducible output
        result = model.inference(text, "hi", latent, embedding,
                                 temperature=0.65, enable_text_splitting=True)
        audio = result["wav"]
        audio = audio.cpu().numpy() if hasattr(audio, "cpu") else audio

        if not args.no_reverb:
            peak = float(abs(audio).max()) or 1.0
            audio = reverb.apply_reverb(audio / peak, rate, wet=reverb.DEFAULT_WET) * peak

        target = OUTPUT_DIR / f"hindi_{name}.wav"
        sf.write(target, audio, rate, subtype="PCM_16")
        print(f"   {target.name}  ({len(audio) / rate:.1f}s)", flush=True)

    print(f"\nListen in {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
