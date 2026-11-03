// "Ask Ruby": the chat controller behind the floating assistant.
//
// js/ruby-assistant.js injects the markup and calls initRubyWidget. The round
// mascot button in the corner opens a small chat overlay. Every question goes to
// /api/ruby/ask together with the payloads for the place currently selected on
// the map (when the page has one), so "how steep is it here?" is answered from
// real data.
// The server decides whether to answer from map data, built-in Mars facts, or
// (for everything else) an AI model, and says which in `source`; the overlay
// shows that label so a measurement is never mistaken for general knowledge.
//
// All text is inserted with textContent, never innerHTML: replies can contain
// text that originated in an external service or a language model.

const HISTORY_TURNS = 6; // matches what the server keeps
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_SPEECH_LENGTH = 600; // must match /api/ruby/speak
const SPEAK_STORAGE_KEY = "ruby.speakReplies";

const SOURCE_LABELS = {
  data: "Map data",
  glossary: "Map guide",
  facts: "Mars facts",
  hybrid: "Map data + AI",
  ai: "AI answer · general knowledge",
};

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readStoredPreference() {
  try {
    return localStorage.getItem(SPEAK_STORAGE_KEY) !== "0";
  } catch {
    return true; // storage can be blocked; default to speaking
  }
}

function storePreference(value) {
  try {
    localStorage.setItem(SPEAK_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Not persisting is fine.
  }
}

export function initRubyWidget({ getSelection, hasSelectionSource = () => true }) {
  const fab = document.getElementById("ruby-fab");
  const chat = document.getElementById("ruby-chat");
  if (!fab || !chat) return { refreshContext() {}, open() {}, close() {} };

  const log = document.getElementById("ruby-chat-log");
  const chips = document.getElementById("ruby-chat-chips");
  const form = document.getElementById("ruby-chat-form");
  const input = document.getElementById("ruby-chat-input");
  const sendButton = document.getElementById("ruby-chat-send");
  const micButton = document.getElementById("ruby-chat-mic");
  const closeButton = document.getElementById("ruby-chat-close");
  const voiceButton = document.getElementById("ruby-chat-voice");
  const contextLabel = document.getElementById("ruby-chat-context");
  const note = document.getElementById("ruby-chat-note");
  const defaultNote = note.textContent;

  const history = []; // { role: "user" | "assistant", content }
  let pending = false;
  let welcomed = false;
  let voiceOnline = false;
  let wantsVoice = readStoredPreference();
  let currentAudio = null;
  let servicesCheckedAt = 0;

  // ---- Conversation -------------------------------------------------------

  function scrollToEnd() {
    log.scrollTop = log.scrollHeight;
  }

  function addUserMessage(text) {
    const wrapper = create("div", "ruby-msg ruby-msg-user");
    wrapper.append(create("p", "ruby-bubble", text));
    log.append(wrapper);
    scrollToEnd();
  }

  function addRubyMessage(text, { source = null, speech = null, error = false } = {}) {
    const wrapper = create("div", `ruby-msg ruby-msg-ruby${error ? " ruby-msg-error" : ""}`);
    wrapper.append(create("p", "ruby-bubble", text));

    const label = SOURCE_LABELS[source];
    const canPlay = voiceOnline && !error;
    if (label || canPlay) {
      const meta = create("div", "ruby-msg-meta");
      if (label) {
        const badge = create("span", "ruby-source", label);
        badge.dataset.source = source;
        meta.append(badge);
      }
      if (canPlay) {
        const play = create("button", "ruby-play", "▶ Play");
        play.type = "button";
        play.setAttribute("aria-label", "Play Ruby's answer aloud");
        play.addEventListener("click", () => speak(speech || text, play));
        meta.append(play);
        wrapper.playButton = play;
      }
      wrapper.append(meta);
    }
    log.append(wrapper);
    scrollToEnd();
    return wrapper;
  }

  function addTyping() {
    const wrapper = create("div", "ruby-msg ruby-msg-ruby");
    const bubble = create("p", "ruby-bubble ruby-typing");
    bubble.setAttribute("role", "status");
    bubble.setAttribute("aria-label", "Ruby is thinking");
    bubble.append(create("i"), create("i"), create("i"));
    wrapper.append(bubble);
    log.append(wrapper);
    scrollToEnd();
    return wrapper;
  }

  function setPending(value) {
    pending = value;
    sendButton.disabled = value;
    input.disabled = value;
    chips.querySelectorAll("button").forEach((button) => {
      button.disabled = value;
    });
  }

  async function send(rawText) {
    const text = String(rawText ?? "").trim();
    if (!text || pending) return;

    stopAudio();
    addUserMessage(text);
    input.value = "";
    setPending(true);
    const typing = addTyping();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch("/api/ruby/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          selection: getSelection(),
          history: history.slice(-HISTORY_TURNS),
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `The request failed (${response.status}).`);

      typing.remove();
      const message = addRubyMessage(payload.reply, { source: payload.source, speech: payload.speech });
      history.push({ role: "user", content: text }, { role: "assistant", content: payload.reply });

      if (payload.aiAvailable === false) {
        note.textContent =
          "AI answers are not set up, so Ruby only uses map data and built-in facts. Add your OpenRouter key to the .env file to enable them.";
      }
      if (wantsVoice && voiceOnline && !chat.hidden) {
        speak(payload.speech || payload.reply, message.playButton);
      }
    } catch (error) {
      typing.remove();
      addRubyMessage(
        error.name === "AbortError"
          ? "That took too long. Please try asking again."
          : `I couldn't get an answer: ${error.message}`,
        { error: true },
      );
    } finally {
      clearTimeout(timer);
      setPending(false);
      if (!chat.hidden) input.focus();
    }
  }

  // ---- Voice --------------------------------------------------------------

  function stopAudio() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    log.querySelectorAll(".ruby-play[aria-busy='true']").forEach((button) => {
      button.removeAttribute("aria-busy");
      button.textContent = "▶ Play";
    });
  }

  async function speak(text, button) {
    if (!text || !voiceOnline) return;
    if (text.length > MAX_SPEECH_LENGTH) text = text.slice(0, MAX_SPEECH_LENGTH);
    stopAudio();
    if (button) {
      button.setAttribute("aria-busy", "true");
      button.textContent = "Loading voice…";
    }
    try {
      const response = await fetch("/api/ruby/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error("voice unavailable");
      const url = URL.createObjectURL(await response.blob());
      const audio = new Audio(url);
      currentAudio = audio;
      const finish = () => {
        URL.revokeObjectURL(url);
        if (button) {
          button.removeAttribute("aria-busy");
          button.textContent = "▶ Play";
        }
        if (currentAudio === audio) currentAudio = null;
      };
      audio.addEventListener("ended", finish, { once: true });
      audio.addEventListener("error", finish, { once: true });
      if (button) button.textContent = "■ Stop";
      await audio.play();
    } catch {
      if (button) {
        button.removeAttribute("aria-busy");
        button.textContent = "Voice unavailable";
      }
    }
  }

  function syncVoiceButton() {
    const active = wantsVoice && voiceOnline;
    voiceButton.setAttribute("aria-pressed", String(active));
    voiceButton.disabled = !voiceOnline;
    voiceButton.title = voiceOnline
      ? active ? "Ruby speaks her replies. Click to mute." : "Ruby is muted. Click to hear her replies."
      : "Ruby's voice server is offline, so replies are text only.";
  }

  voiceButton.addEventListener("click", () => {
    wantsVoice = !wantsVoice;
    storePreference(wantsVoice);
    if (!wantsVoice) stopAudio();
    syncVoiceButton();
  });

  // Checked when the chat opens, at most every 30 s, rather than on a timer.
  async function checkServices() {
    if (Date.now() - servicesCheckedAt < 30_000) return;
    servicesCheckedAt = Date.now();
    try {
      const [voice, ai] = await Promise.all([
        fetch("/api/ruby/voice-status").then((r) => r.json()),
        fetch("/api/ruby/ai-status").then((r) => r.json()),
      ]);
      voiceOnline = Boolean(voice.online);
      note.textContent = ai.configured
        ? defaultNote
        : "AI answers are not set up, so Ruby only uses map data and built-in facts. Add your OpenRouter key to the .env file to enable them.";
    } catch {
      voiceOnline = false;
    }
    syncVoiceButton();
  }

  // ---- Microphone (Chrome and Edge) ---------------------------------------

  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (Recognition) {
    micButton.hidden = false;
    const recognizer = new Recognition();
    recognizer.lang = "en-US";
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;
    recognizer.addEventListener("start", () => micButton.setAttribute("aria-pressed", "true"));
    recognizer.addEventListener("end", () => micButton.setAttribute("aria-pressed", "false"));
    recognizer.addEventListener("result", (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (transcript) send(transcript);
    });
    recognizer.addEventListener("error", (event) => {
      addRubyMessage(
        event.error === "not-allowed"
          ? "Microphone access is blocked. Allow it in the browser, or type your question."
          : `The microphone had a problem (${event.error}). You can type instead.`,
        { error: true },
      );
    });
    micButton.addEventListener("click", () => {
      if (pending) return;
      stopAudio(); // so Ruby does not hear herself
      try {
        recognizer.start();
      } catch {
        // start() throws if recognition is already running; ignore.
      }
    });
  }

  // ---- Context: what Ruby is currently looking at -------------------------

  function placeName(selection) {
    return selection?.feature?.name || selection?.region?.name || selection?.title || null;
  }

  function renderChips(hasData) {
    const suggestions = hasData
      ? ["Tell me about this place", "How steep is it here?", "What's the surface like?", "How cold is it?", "What is thermal inertia?"]
      : ["What is the gravity on Mars?", "Why is Mars red?", "What is the Mars datum?", "How long is a sol?"];
    chips.replaceChildren(
      ...suggestions.map((label) => {
        const chip = create("button", "ruby-chip", label);
        chip.type = "button";
        chip.disabled = pending;
        chip.addEventListener("click", () => send(label));
        return chip;
      }),
    );
  }

  let lastChipState = null;
  function refreshContext() {
    const selection = getSelection();
    const name = placeName(selection);
    const hasData = Boolean(selection && (selection.point || selection.cell));

    contextLabel.classList.remove("is-ready", "is-loading");
    if (!hasSelectionSource()) {
      contextLabel.textContent = "Mars assistant"; // this page has no map to select from
    } else if (!selection || !name) {
      contextLabel.textContent = "No place selected";
    } else if (selection.status === "loading") {
      contextLabel.textContent = `${name} · loading…`;
      contextLabel.classList.add("is-loading");
    } else if (hasData) {
      contextLabel.textContent = `${name} · data ready`;
      contextLabel.classList.add("is-ready");
    } else {
      contextLabel.textContent = `${name} · no data`;
    }
    contextLabel.title = contextLabel.textContent; // full text if it is clipped

    if (lastChipState !== hasData) {
      lastChipState = hasData;
      renderChips(hasData);
    }
  }

  function welcome() {
    if (welcomed) return;
    welcomed = true;
    const name = placeName(getSelection());
    addRubyMessage(
      name
        ? `Hi, I'm Ruby. Ask me about ${name}, a Mars term, or anything about Mars.`
        : hasSelectionSource()
          ? "Hi, I'm Ruby. Select a place on the map and ask me about it, or ask me anything about Mars."
          : "Hi, I'm Ruby. Ask me anything about Mars, or open the map and select a place to ask about it.",
    );
  }

  // ---- Open / close -------------------------------------------------------

  function open() {
    chat.hidden = false;
    fab.setAttribute("aria-expanded", "true");
    refreshContext();
    welcome();
    checkServices();
    scrollToEnd(); // the layout may have changed while the chat was closed
    input.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (chat.hidden) return;
    stopAudio();
    const hadFocus = chat.contains(document.activeElement);
    chat.hidden = true;
    fab.setAttribute("aria-expanded", "false");
    if (restoreFocus && hadFocus) fab.focus();
  }

  fab.addEventListener("click", () => (chat.hidden ? open() : close()));
  closeButton.addEventListener("click", () => close());
  chat.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    send(input.value);
  });

  return { refreshContext, open, close };
}
