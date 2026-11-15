// Browser-native speech for Ruby, synthesized by each visitor's device.

let activeUtterance = null;
let finishActive = null;

export function rubySpeechAvailable() {
  return typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance === "function";
}

function chooseVoice(text) {
  const voices = window.speechSynthesis.getVoices();
  const hindiText = /[\u0900-\u097F]/.test(text);
  const preferred = hindiText ? ["hi-IN", "hi"] : ["en-IN", "en-GB", "en-US", "en"];
  for (const language of preferred) {
    const voice = voices.find((item) => item.lang?.toLowerCase() === language.toLowerCase()) ||
      voices.find((item) => item.lang?.toLowerCase().startsWith(`${language.toLowerCase()}-`));
    if (voice) return voice;
  }
  return voices.find((voice) => voice.default) || voices[0] || null;
}

export function cancelRubySpeech() {
  if (!rubySpeechAvailable()) return;
  window.speechSynthesis.cancel();
  finishActive?.(false);
}

export function speakRubyText(text) {
  const clean = String(text || "").trim();
  if (!clean) return Promise.resolve(false);
  if (!rubySpeechAvailable()) return Promise.reject(new Error("Browser speech synthesis is unavailable."));

  cancelRubySpeech();
  const utterance = new window.SpeechSynthesisUtterance(clean);
  const voice = chooseVoice(clean);
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = /[\u0900-\u097F]/.test(clean) ? "hi-IN" : "en-IN";
  }
  utterance.rate = 1.02;
  utterance.pitch = 1.04;
  utterance.volume = 1;

  activeUtterance = utterance;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (completed, error = null) => {
      if (settled) return;
      settled = true;
      if (activeUtterance === utterance) activeUtterance = null;
      if (finishActive === finish) finishActive = null;
      if (error) reject(error);
      else resolve(completed);
    };
    finishActive = finish;
    utterance.onend = () => finish(true);
    utterance.onerror = (event) => {
      if (event.error === "canceled" || event.error === "interrupted") finish(false);
      else finish(false, new Error(`System voice failed: ${event.error || "unknown error"}`));
    };
    window.speechSynthesis.speak(utterance);
  });
}
