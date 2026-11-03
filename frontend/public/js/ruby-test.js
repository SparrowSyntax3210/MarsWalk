// Ruby voice prototype: text/mic input -> /api/ruby/ask -> /api/ruby/speak.
const statusBox = document.getElementById("voice-status");
const log = document.getElementById("chat-log");
const form = document.getElementById("ask-form");
const input = document.getElementById("ask-input");
const micButton = document.getElementById("mic-button");
const speakToggle = document.getElementById("speak-toggle");

let voiceOnline = false;
let currentAudio = null;

function setStatus(message, tone = "") {
  statusBox.textContent = message;
  statusBox.className = `ruby-status${tone ? ` is-${tone}` : ""}`;
}

function addMessage(text, from, note = "") {
  const item = document.createElement("li");
  item.className = from === "user" ? "from-user" : "from-ruby";
  item.textContent = text;
  if (note) {
    const small = document.createElement("small");
    small.textContent = note;
    item.append(small);
  }
  log.append(item);
  log.scrollTop = log.scrollHeight;
  return item;
}

async function checkVoice() {
  try {
    const status = await (await fetch("/api/ruby/voice-status")).json();
    voiceOnline = Boolean(status.online);
    if (voiceOnline) {
      setStatus(`Ruby's voice is ready (${status.model} on ${status.device.toUpperCase()}).`, "good");
    } else {
      setStatus("Voice server is offline. Ruby will reply in text. Start python/ruby_voice/sovits_server.py to hear her.", "error");
    }
  } catch {
    voiceOnline = false;
    setStatus("Could not reach the MarsWalk backend.", "error");
  }
}

async function speak(text, bubble) {
  if (!speakToggle.checked || !voiceOnline) return;
  const note = document.createElement("small");
  note.textContent = "Generating voice…";
  bubble.append(note);

  try {
    const started = performance.now();
    const response = await fetch("/api/ruby/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || "Voice request failed");

    const url = URL.createObjectURL(await response.blob());
    currentAudio?.pause();
    currentAudio = new Audio(url);
    currentAudio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
    await currentAudio.play();
    note.textContent = `Spoken in Ruby's voice · generated in ${((performance.now() - started) / 1000).toFixed(1)} s`;
  } catch (error) {
    note.textContent = `Voice unavailable: ${error.message}`;
  }
}

async function ask(message) {
  addMessage(message, "user");
  form.querySelector("button[type=submit]").disabled = true;
  try {
    const response = await fetch("/api/ruby/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Ruby could not answer");
    const bubble = addMessage(payload.reply, "ruby");
    await speak(payload.reply, bubble);
  } catch (error) {
    addMessage(`Something went wrong: ${error.message}`, "ruby");
  } finally {
    form.querySelector("button[type=submit]").disabled = false;
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  ask(message);
});

// Browser speech recognition (Chrome / Edge). Hidden gracefully elsewhere.
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Recognition) {
  const recognizer = new Recognition();
  recognizer.lang = "en-US";
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;

  micButton.addEventListener("click", () => {
    currentAudio?.pause();
    recognizer.start();
  });
  recognizer.addEventListener("start", () => micButton.setAttribute("aria-pressed", "true"));
  recognizer.addEventListener("end", () => micButton.setAttribute("aria-pressed", "false"));
  recognizer.addEventListener("result", (event) => {
    const transcript = event.results[0][0].transcript.trim();
    if (transcript) ask(transcript);
  });
  recognizer.addEventListener("error", (event) => {
    setStatus(`Microphone error: ${event.error}. You can type instead.`, "error");
  });
} else {
  micButton.disabled = true;
  micButton.title = "Speech recognition needs Chrome or Edge";
}

checkVoice();
addMessage("Hi, I'm Ruby. Say hello, or ask me about elevation or Mars.", "ruby");
