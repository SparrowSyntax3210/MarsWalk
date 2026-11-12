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
const QUICK_SPEECH_LENGTH = 95;
const SPEAK_STORAGE_KEY = "ruby.speakReplies";
const WAKE_STORAGE_KEY = "ruby.wakeWord.v2";
const LEGACY_WAKE_STORAGE_KEY = "ruby.wakeWord";

const SOURCE_LABELS = {
  data: "Map data",
  glossary: "Map guide",
  facts: "Mars facts",
  hybrid: "Map data + AI",
  ai: "AI answer · general knowledge",
  route: "Mars route planner",
  tour: "MarsWalk tour",
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

function readWakePreference() {
  try {
    const saved = localStorage.getItem(WAKE_STORAGE_KEY);
    if (saved === "1") return true;
    if (saved === "0") return false;
    // Older builds also wrote "0" after transient network errors. Treat that
    // old value as unset so an already-approved microphone can recover.
    return localStorage.getItem(LEGACY_WAKE_STORAGE_KEY) === "1" ? true : null;
  } catch {
    return null;
  }
}

function storeWakePreference(value) {
  try {
    localStorage.setItem(WAKE_STORAGE_KEY, value ? "1" : "0");
  } catch {
    // Wake word can still be used for the current page session.
  }
}

export function initRubyWidget({ getSelection, hasSelectionSource = () => true, inline = false }) {
  const fab = document.getElementById("ruby-fab");
  const chat = document.getElementById("ruby-chat") || document.querySelector("[data-ruby-chat]");
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
  const stateBadge = create("span", "ruby-state-pill", "Active");
  document.querySelector(".ruby-chat-titles")?.append(stateBadge);
  const presence = create("div", "ruby-presence", "Ruby is active");
  presence.hidden = true;
  presence.setAttribute("role", "status");
  presence.setAttribute("aria-live", "polite");
  document.body.append(presence);
  const stateDot = create("span", "ruby-state-dot");
  stateDot.setAttribute("aria-hidden", "true");
  fab.append(stateDot);

  const history = []; // { role: "user" | "assistant", content }
  let pending = false;
  let welcomed = false;
  let voiceOnline = false;
  let wantsVoice = readStoredPreference();
  let currentAudio = null;
  let speechController = null;
  let servicesCheckedAt = 0;
  let rubyAwake = true;
  let lastExplanation = "";
  let presenceTimer = null;
  const savedWakePreference = readWakePreference();
  let wakeEnabled = savedWakePreference === true;
  let wakeChoiceMade = savedWakePreference !== null;
  let awaitingWakeCommand = false;
  let tourActive = false;
  let tourStepTimer = null;
  let resolveTourStep = null;
  let enableWakeWord = () => false;

  function finishTourWait() {
    if (tourStepTimer) clearTimeout(tourStepTimer);
    tourStepTimer = null;
    const resolve = resolveTourStep;
    resolveTourStep = null;
    resolve?.();
  }

  function setPresence(state, message, reveal = false) {
    fab.dataset.rubyState = state;
    presence.dataset.state = state;
    stateBadge.dataset.state = state;
    stateBadge.textContent = state === "sleeping" ? "Sleeping" : state === "working" ? "Working" : state === "listening" ? "Listening" : "Active";
    presence.textContent = message;
    if (presenceTimer) clearTimeout(presenceTimer);
    if (reveal) presence.hidden = false;
    if (!presence.hidden && state !== "working" && state !== "listening") {
      presenceTimer = setTimeout(() => { presence.hidden = true; }, state === "sleeping" ? 8000 : 4500);
    }
  }
  setPresence("active", "Ruby is active and ready.");

  function setReadyPresence(message = "Ruby is active and ready.", reveal = false) {
    setPresence(
      wakeEnabled ? "listening" : "active",
      wakeEnabled ? "Wake word active · say “Ruby” and your request." : message,
      reveal,
    );
  }

  function localReply(reply, { source = null, speech = reply, userText = "" } = {}) {
    const message = addRubyMessage(reply, { source, speech });
    history.push({ role: "user", content: userText }, { role: "assistant", content: reply });
    if (wantsVoice && voiceOnline && speech) speak(speech, message.playButton);
  }

  function quickSpeech(text) {
    return splitSpeechChunks(text, QUICK_SPEECH_LENGTH, 3).join(" ");
  }

  function splitSpeechChunks(text, chunkLimit, maxChunks) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const protectedClean = clean.replace(/(\d)\.(\d)/g, "$1\uE000$2");
    const sentences = (protectedClean.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [protectedClean])
      .map((sentence) => sentence.replace(/\uE000/g, "."));
    const chunks = [];
    let current = "";

    for (const rawSentence of sentences) {
      let sentence = rawSentence.trim();
      while (sentence.length > chunkLimit) {
        const cut = sentence.lastIndexOf(" ", chunkLimit - 1);
        if (cut <= 0) break;
        const part = sentence.slice(0, cut).trim();
        if (current) chunks.push(current);
        chunks.push(part);
        current = "";
        sentence = sentence.slice(cut + 1).trim();
        if (chunks.length >= maxChunks) return chunks.slice(0, maxChunks);
      }
      if (!sentence) continue;
      const next = `${current}${current ? " " : ""}${sentence}`;
      if (next.length <= chunkLimit) current = next;
      else {
        if (current) chunks.push(current);
        current = sentence;
      }
      if (chunks.length >= maxChunks) return chunks.slice(0, maxChunks);
    }
    if (current && chunks.length < maxChunks) chunks.push(current);
    return chunks.slice(0, maxChunks);
  }

  async function explainSelectedPoint({ signal } = {}) {
    const narration = await window.MarsWalkRuby?.explainSelectedPoint?.({ signal });
    if (!narration) throw new Error("Select a point on the Explore map first, then ask me to explain it.");
    const details = (narration.sections || [])
      .filter((section) => section.text)
      .map((section) => `${section.label}: ${section.text}`);
    return {
      reply: [narration.summary, ...details].filter(Boolean).join("\n\n"),
      speech: narration.summary,
    };
  }

  async function runProjectTour(userText) {
    const bridge = window.MarsWalkRuby;
    const startingView = bridge?.getCurrentView?.() || "explore";
    const steps = [
      {
        view: "explore",
        title: "Home and Surface Explorer",
        text: "MarsWalk opens with an interactive Mars landing page and a link into this workspace. The Surface Explorer combines the Mars globe, named landing sites, orbital imagery, and map layers. Select a point to inspect terrain, geology, elevation, and climate data.",
      },
      {
        view: "route",
        title: "Route Planning",
        text: "Route Planning builds candidate paths between named places or coordinates. Choose Safest, Balanced, or Fast, then review distance, slope, terrain classes, and nearby features. These are terrain planning results, not rover-certified safety guarantees.",
      },
      {
        view: "mission",
        title: "Mission Planner",
        text: "The Mission Planner compares route options and estimates traverse time, energy, and crew oxygen from the assumptions you enter. You can review warnings, audit a custom traverse, and download or print the report. These values are planning estimates, not live vehicle telemetry.",
      },
      {
        view: "ar-engine",
        title: "3D and head tracking",
        text: "The 3D and AR section links to the Jezero terrain walk and a head-tracking demo. Jezero uses a terrain mesh with touch or gamepad movement; the phone gyro bridge can provide camera look when connected. These views open as separate pages in this browser tab.",
      },
      {
        view: "explore",
        title: "Data and services",
        text: "Behind the dashboard, MarsWalk has services for point and elevation lookups, map-cell data, terrain route planning, and assistant answers and spoken briefings. The planner and mission screens use these results to show route shape, terrain classes, and estimates together.",
      },
      {
        view: "explore",
        title: "Ruby and the project workflow",
        text: "You can ask me about map selections, ask me to calculate a route, or say explain for a route briefing. This project brings together the Mars data website, route and mission planning, the Jezero 3D experience, and phone-based head tracking.",
      },
    ];

    tourActive = true;
    setPending(true);
    setPresence("working", "Ruby is taking you on a MarsWalk project tour…", true);
    history.push({ role: "user", content: userText });
    try {
      for (const step of steps) {
        if (!tourActive) break;
        bridge?.showTourView?.(step.view);
        const wrapper = addRubyMessage(step.text, { source: "tour", speech: step.text });
        history.push({ role: "assistant", content: step.text });
        setPresence("working", `Project tour · ${step.title}`, true);
        if (wantsVoice && voiceOnline) {
          await speak(step.text, wrapper.playButton);
        } else {
          await new Promise((resolve) => {
            resolveTourStep = resolve;
            tourStepTimer = setTimeout(() => {
              tourStepTimer = null;
              resolveTourStep = null;
              resolve();
            }, 4500);
          });
        }
      }
      if (tourActive) {
        const ending = "That’s the MarsWalk project tour. Ask me to revisit any section or explain what you see.";
        const wrapper = addRubyMessage(ending, { source: "tour", speech: ending });
        history.push({ role: "assistant", content: ending });
        if (wantsVoice && voiceOnline) await speak(ending, wrapper.playButton);
      }
    } finally {
      tourActive = false;
      finishTourWait();
      bridge?.showTourView?.(startingView);
      setPending(false);
      setReadyPresence();
      if (!chat.hidden) input.focus();
    }
  }

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

  function addRubyMessage(text, { source = null, speech = null, error = false, speakOptions = {} } = {}) {
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
        play.addEventListener("click", () => speak(speech || text, play, speakOptions));
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

  function normalizeMarsVoiceTerms(value) {
    let result = String(value ?? "");
    const isRouteRequest = /\b(?:draw|drawer|plan|calculate|create|make|show|find|navigate|guide|take me|route me|go to|head to|get me to)\b/i.test(result) &&
      /\b(?:route|routes|root|roots|rout|path|traverse|map|directions|from\b.*\bto\b|to\s+(?:the\s+)?(?:delta|lake|jezero|western|north))\b/i.test(result);
    if (!isRouteRequest) return result;
    result = result
      .replace(/\bdrawer(?:\s+a)?(?=\s+(?:routes?|map|path|directions)\b)/gi, "draw a")
      .replace(/\bdrawer\b/gi, "draw a")
      .replace(/\b(?:root|roots|rout)\b/gi, (word) => word.toLowerCase() === "roots" ? "routes" : "route")
      .replace(/\bancient\s+lake\s+bed\b/gi, "Ancient Lakebed")
      .replace(/\blake\s+bed\b/gi, "lakebed")
      .replace(/\bdelta\s+out\s+crop\b/gi, "Delta Outcrop")
      .replace(/\bwest\s+fan\b/gi, "Western Fan")
      .replace(/\bnorth\s+rim\s+look\s+out\b/gi, "North Rim Lookout")
      .replace(/\bjezero\s+landing\b/gi, "Jezero Landing Zone");
    return result;
  }

  function selectVoiceAlternative(result) {
    if (!result?.length) return "";
    const candidates = Array.from(result)
      .map((alternative) => String(alternative?.transcript ?? "").trim())
      .filter(Boolean);
    const score = (candidate) => {
      const corrected = normalizeMarsVoiceTerms(candidate).toLowerCase();
      let value = 0;
      if (/\b(?:route|routes|path|traverse|map)\b/.test(corrected)) value += 5;
      if (/\b(?:draw|plan|calculate|create|show|make|find|navigate|guide)\b/.test(corrected)) value += 3;
      if (/\b(?:from|to)\b/.test(corrected)) value += 2;
      if (/\b(?:jezero|delta|outcrop|lakebed|lake\s+bed|western fan|west fan|north rim|lookout|gale crater|gale)\b/.test(corrected)) value += 4;
      if (/\b(?:root|roots|rout)\b/.test(candidate.toLowerCase())) value += 1;
      return value;
    };
    return candidates.reduce((best, candidate) => score(candidate) > score(best) ? candidate : best, candidates[0]);
  }

  async function send(rawText, { fromWakeWord = false } = {}) {
    const text = String(rawText ?? "").trim();
    const commandText = fromWakeWord ? normalizeMarsVoiceTerms(text) : text;
    const normalizedCommand = commandText.toLocaleLowerCase().replace(/^ruby[, ]+/g, "ruby ").replace(/[,.!?…\s]+$/g, "").trim();
    const canInterrupt = /^(?:(?:ruby\s+)?(?:stop\s+(?:speaking|talking)|be\s+quiet))$/.test(normalizedCommand);
    if (!text || (pending && !canInterrupt)) return;

    stopAudio();
    if (fromWakeWord) welcome();
    addUserMessage(text);
    input.value = "";
    let requestText = commandText;
    const command = normalizedCommand;
    const wakeCommand = /^(?:ruby\s+)?(?:wake(?:\s+up)?|awake)(?:\s+ruby)?$/.test(command);
    const sleepCommand = /^(?:ruby\s+)?(?:sleep|go\s+to\s+sleep)(?:\s+ruby)?$/.test(command);
    const stopCommand = canInterrupt;
    const explainCommand = /^(?:ruby\s+)?explain(?:\s+(?:that|it|the\s+route))?$/.test(command);
    const explainPointCommand = /\b(?:explain|describe|tell me about)\s+(?:(?:this|that|the selected|current)\s+)?(?:point|place|location|spot)\b/.test(command);
    const tourCommand = /\b(?:project\s+tour|tour\s+(?:(?:the\s+)?(?:complete|full)\s+)?(?:project|marswalk)|give\s+me\s+(?:a\s+)?(?:complete\s+|full\s+)?tour|take\s+me\s+on\s+(?:a\s+)?(?:complete\s+|full\s+)?tour|start\s+(?:the\s+)?tour)\b/.test(command);

    if (wakeCommand) {
      rubyAwake = true;
      setReadyPresence("Ruby is active and ready.", true);
      localReply("I’m awake and ready. Tell me what you’d like me to do.", { userText: text });
      return;
    }
    if (sleepCommand) {
      rubyAwake = false;
      stopAudio();
      setPresence("sleeping", "Ruby is sleeping · say “Ruby wake up” to resume.", true);
      localReply("Going to sleep. Say “Ruby wake up” when you need me.", { userText: text, speech: "" });
      stopAudio();
      return;
    }
    if (stopCommand) {
      stopAudio();
      tourActive = false;
      finishTourWait();
      setPending(false);
      if (rubyAwake) setReadyPresence("Speaking stopped.", true);
      else setPresence("sleeping", "Speaking stopped. Ruby is still asleep.", true);
      localReply("Stopped speaking.", { userText: text, speech: "" });
      stopAudio();
      return;
    }
    if (!rubyAwake) {
      setPresence("sleeping", "Ruby is sleeping · say “Ruby wake up” to resume.", true);
      localReply("I’m asleep right now. Say “Ruby wake up” before giving me another task.", { userText: text, speech: "" });
      return;
    }
    if (tourCommand) {
      await runProjectTour(text);
      return;
    }
    if (explainCommand) {
      if (lastExplanation) {
        setReadyPresence("Ruby is explaining the last route.", true);
        localReply(lastExplanation, { source: "route", userText: text });
        return;
      }
      requestText = "Explain your previous answer in simpler terms.";
    } else {
      requestText = commandText.replace(/^ruby\s+do\s+this\s*[:,]?\s*/i, "").trim();
      if (!requestText) {
        localReply("What should I do? For example, ask me to plan a route from Gale Crater to Jezero Crater.", { userText: text });
        return;
      }
    }

    setPending(true);
    setPresence("working", "Ruby is working on your request…", true);
    const typing = addTyping();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      if (explainPointCommand) {
        const result = await explainSelectedPoint({ signal: controller.signal });
        typing.remove();
        const message = addRubyMessage(result.reply, {
          source: "data",
          speech: result.speech,
          speakOptions: { shorten: false },
        });
        history.push({ role: "user", content: text }, { role: "assistant", content: result.reply });
        if (wantsVoice && voiceOnline && (!chat.hidden || fromWakeWord)) {
          await speak(result.speech, message.playButton, { shorten: false });
        }
        setReadyPresence();
        return;
      }
      // Route commands are parsed by a deterministic server allow-list before
      // the general Ruby answer service is called.
      const actionResponse = await fetch("/api/ruby/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: requestText }),
        signal: controller.signal,
      });
      const actionPayload = await actionResponse.json().catch(() => ({}));
      if (actionResponse.ok && actionPayload.handled) {
        typing.remove();
        let result = actionPayload;
        if (actionPayload.action) {
          const action = actionPayload.action;
          if (
            action.type !== "plan_route" ||
            !["safest", "balanced", "fastest"].includes(action.mode) ||
            ![action.start?.lat, action.start?.lon, action.end?.lat, action.end?.lon].every(Number.isFinite)
          ) {
            throw new Error("Ruby returned an invalid route request.");
          }
          if (typeof window.MarsWalkRuby?.performAction !== "function") {
            result = {
              reply: "Open the MarsWalk dashboard and ask Ruby to plan that route there.",
            };
          } else {
            result = await window.MarsWalkRuby.performAction(action);
          }
        }
        const reply = result.reply || "I couldn't complete that route request.";
        if (result.explanation) lastExplanation = result.explanation;
        const message = addRubyMessage(reply, { source: result.source || (result.action ? null : "route"), speech: result.speech || reply });
        history.push({ role: "user", content: requestText }, { role: "assistant", content: reply });
        if (wantsVoice && voiceOnline && (!chat.hidden || result.source === "route" || fromWakeWord)) {
          await speak(result.speech || reply, message.playButton);
        }
        setReadyPresence();
        return;
      }

      const response = await fetch("/api/ruby/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: requestText,
          selection: getSelection(),
          history: history.slice(-HISTORY_TURNS),
        }),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `The request failed (${response.status}).`);

      typing.remove();
      const message = addRubyMessage(payload.reply, { source: payload.source, speech: payload.speech });
      history.push({ role: "user", content: requestText }, { role: "assistant", content: payload.reply });
      lastExplanation = "";

      if (payload.aiAvailable === false) {
        note.textContent =
          "AI answers are not set up, so Ruby only uses map data and built-in facts. Add your OpenRouter key to the .env file to enable them.";
      }
      if (wantsVoice && voiceOnline && (!chat.hidden || fromWakeWord)) {
        await speak(payload.speech || payload.reply, message.playButton);
      }
      setReadyPresence();
    } catch (error) {
      typing.remove();
      addRubyMessage(
        error.name === "AbortError"
          ? "That took too long. Please try asking again."
          : `I couldn't get an answer: ${error.message}`,
        { error: true },
      );
      setReadyPresence("Ruby is active, but that request failed.", true);
    } finally {
      clearTimeout(timer);
      setPending(false);
      if (!chat.hidden) input.focus();
    }
  }

  // ---- Voice --------------------------------------------------------------

  function stopAudio() {
    if (speechController) {
      speechController.abort();
      speechController = null;
    }
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    log.querySelectorAll(".ruby-play[aria-busy='true']").forEach((button) => {
      button.removeAttribute("aria-busy");
      button.textContent = "▶ Play";
    });
  }

  async function speak(text, button, { shorten = true } = {}) {
    if (!text || !voiceOnline) return;
    if (shorten) text = quickSpeech(text);
    if (text.length > MAX_SPEECH_LENGTH) text = text.slice(0, MAX_SPEECH_LENGTH);
    const chunks = splitSpeechChunks(text, QUICK_SPEECH_LENGTH, 3);
    if (!chunks.length) return;
    stopAudio();
    const controller = new AbortController();
    speechController = controller;
    if (button) {
      button.setAttribute("aria-busy", "true");
      button.textContent = "Loading voice…";
    }
    try {
      const fetchChunk = (chunk) => fetch("/api/ruby/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunk }),
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) throw new Error("voice unavailable");
        return { blob: await response.blob() };
      }).catch((error) => ({ error }));

      let pendingChunk = fetchChunk(chunks[0]);
      for (let index = 0; index < chunks.length; index += 1) {
        const result = await pendingChunk;
        if (result.error) throw result.error;
        const url = URL.createObjectURL(result.blob);
        const audio = new Audio(url);
        currentAudio = audio;
        let resolvePlayback;
        const playbackFinished = new Promise((resolve) => { resolvePlayback = resolve; });
        const finish = () => {
          URL.revokeObjectURL(url);
          if (currentAudio === audio) currentAudio = null;
          resolvePlayback();
        };
        audio.addEventListener("ended", finish, { once: true });
        audio.addEventListener("error", finish, { once: true });
        audio.addEventListener("pause", finish, { once: true });
        if (button) button.textContent = "■ Stop";
        const playback = audio.play();
        if (index + 1 < chunks.length) pendingChunk = fetchChunk(chunks[index + 1]);
        await playback;
        await playbackFinished;
      }
      if (button) {
        button.removeAttribute("aria-busy");
        button.textContent = "▶ Play";
      }
      if (speechController === controller) speechController = null;
    } catch (error) {
      if (speechController === controller) speechController = null;
      if (error.name === "AbortError") return;
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
      const voiceNote = wakeEnabled
        ? "Wake word is on while MarsWalk is open. Say “Ruby” and then your request."
        : defaultNote;
      const aiNote = ai.configured
        ? ""
        : "AI answers are not set up, so Ruby only uses map data and built-in facts.";
      const performanceNote = voice.online && voice.device === "cpu"
        ? "Ruby voice is running on CPU, so speech generation may be slower."
        : "";
      note.textContent = [aiNote, performanceNote, voiceNote].filter(Boolean).join(" ");
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
    recognizer.continuous = true;
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 5;
    let recognitionRunning = false;
    let wakeSuspended = false;
    let restartTimer = null;
    let recognitionRetryCount = 0;

    function startWakeRecognition() {
      if (!wakeEnabled || wakeSuspended || recognitionRunning) return;
      try {
        recognizer.start();
      } catch (error) {
        // The browser may still be completing its previous recognition session.
        if (error.name === "InvalidStateError") return;
        recognitionRetryCount += 1;
        const delay = Math.min(30_000, 1_000 * (2 ** Math.min(recognitionRetryCount - 1, 5)));
        setPresence("listening", "Browser speech recognition paused · Ruby will retry automatically.", true);
        restartTimer = setTimeout(startWakeRecognition, delay);
      }
    }

    enableWakeWord = () => {
      wakeChoiceMade = true;
      if (!wakeEnabled) {
        wakeEnabled = true;
        storeWakePreference(true);
      }
      awaitingWakeCommand = false;
      wakeSuspended = false;
      setPresence("listening", "Starting Ruby wake word…", true);
      startWakeRecognition();
      checkServices();
      return true;
    };

    recognizer.addEventListener("start", () => {
      recognitionRunning = true;
      restartTimer = null;
      micButton.setAttribute("aria-pressed", "true");
      micButton.setAttribute("aria-label", "Turn off Ruby wake word");
      micButton.title = "Wake word is on. Say Ruby, then your request. Click to turn it off.";
      note.textContent = "Wake word stays on while MarsWalk is open, including when another app is in front. Browser speech recognition may process audio through its speech service.";
      setPresence(rubyAwake ? "listening" : "sleeping", rubyAwake ? "Wake word active · say “Ruby” and then your request." : "Ruby is sleeping · wake word active, say “Ruby wake up”.", true);
    });
    recognizer.addEventListener("end", () => {
      recognitionRunning = false;
      if (wakeEnabled && !wakeSuspended) {
        const retryDelay = recognitionRetryCount
          ? Math.min(30_000, 1_000 * (2 ** Math.min(recognitionRetryCount - 1, 5)))
          : 500;
        restartTimer = setTimeout(startWakeRecognition, retryDelay);
        return;
      }
      micButton.setAttribute("aria-pressed", "false");
      micButton.setAttribute("aria-label", "Enable Ruby wake word");
      if (!wakeEnabled) {
        micButton.title = "Enable Ruby wake word";
        note.textContent = defaultNote;
        setPresence(rubyAwake ? "active" : "sleeping", rubyAwake ? "Ruby is active and ready." : "Ruby is sleeping.");
      }
    });
    recognizer.addEventListener("result", (event) => {
      const result = event.results[event.resultIndex];
      if (!result?.isFinal) return;
      const transcript = selectVoiceAlternative(result);
      if (!transcript) return;
      recognitionRetryCount = 0;
      const normalized = transcript.toLocaleLowerCase().replace(/[,.!?…\s]+$/g, "").trim();
      if (/^(?:stop\s+(?:speaking|talking)|be\s+quiet)$/.test(normalized)) {
        send(transcript, { fromWakeWord: true });
        return;
      }
      if (awaitingWakeCommand) {
        awaitingWakeCommand = false;
        send(`Ruby ${transcript}`, { fromWakeWord: true });
        return;
      }
      const wakeMatch = transcript.match(/^(?:hey\s+)?ruby\b[,:\s]*(.*)$/i);
      if (!wakeMatch) return;
      const request = wakeMatch[1].trim();
      if (request) {
        send(transcript, { fromWakeWord: true });
      } else {
        awaitingWakeCommand = true;
        setPresence("listening", "Ruby heard you · go ahead with your request.", true);
        note.textContent = "I heard “Ruby”. Say your request now.";
      }
    });
    recognizer.addEventListener("error", (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        wakeEnabled = false;
        wakeChoiceMade = true;
        storeWakePreference(false);
        awaitingWakeCommand = false;
        micButton.setAttribute("aria-pressed", "false");
        micButton.setAttribute("aria-label", "Enable Ruby wake word");
        micButton.title = "Enable Ruby wake word";
        setPresence("active", "Microphone access is blocked. Allow it in the browser settings.", true);
        addRubyMessage("Microphone access is blocked. Allow it in your browser settings, then turn on the wake word again.", { error: true });
      } else if (event.error === "network" && wakeEnabled && !wakeSuspended) {
        recognitionRetryCount += 1;
        setPresence("listening", "Browser speech recognition paused · Ruby will retry automatically.", true);
        note.textContent = "Wake word recognition is reconnecting. You can still type to Ruby.";
      }
    });
    micButton.addEventListener("click", () => {
      wakeChoiceMade = true;
      if (wakeEnabled) {
        wakeEnabled = false;
        storeWakePreference(false);
        awaitingWakeCommand = false;
        wakeSuspended = true;
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = null;
        if (recognitionRunning) recognizer.stop();
        micButton.setAttribute("aria-pressed", "false");
        micButton.setAttribute("aria-label", "Enable Ruby wake word");
        micButton.title = "Enable Ruby wake word";
        note.textContent = defaultNote;
        setPresence(rubyAwake ? "active" : "sleeping", rubyAwake ? "Wake word listening is off." : "Ruby is sleeping. Wake word listening is off.", true);
      } else {
        enableWakeWord();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        wakeSuspended = false;
        startWakeRecognition();
      }
    });

    micButton.setAttribute("aria-label", "Enable Ruby wake word");
    micButton.title = "Enable Ruby wake word";
    if (wakeEnabled) {
      setPresence("listening", "Starting your saved Ruby wake word setting…", true);
      startWakeRecognition();
      checkServices();
    } else if (!wakeChoiceMade && navigator.permissions?.query) {
      navigator.permissions.query({ name: "microphone" }).then((permission) => {
        if (permission.state === "granted" && !wakeChoiceMade) enableWakeWord();
      }).catch(() => {});
    }
  } else {
    note.textContent = "Voice wake words are not supported in this browser. You can still type to Ruby.";
  }

  // ---- Context: what Ruby is currently looking at -------------------------

  function placeName(selection) {
    return selection?.feature?.name || selection?.region?.name || selection?.title || null;
  }

  function renderChips(hasData) {
    const suggestions = hasData
      ? ["Tell me about this place", "How steep is it here?", "What's the surface like?", "How cold is it?", "What is thermal inertia?", "Give me a complete project tour"]
      : ["What is the gravity on Mars?", "Why is Mars red?", "What is the Mars datum?", "How long is a sol?", "Give me a complete project tour"];
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
        ? `Hi, I'm Ruby. Ask me about ${name}, say “Ruby” and your request after enabling the mic, or ask for a complete project tour.`
        : hasSelectionSource()
          ? "Hi, I'm Ruby. Select a place and ask me about it, say “Ruby” after enabling the mic, or ask for a complete project tour."
          : "Hi, I'm Ruby. Ask me anything about Mars or for a complete project tour. Click the mic once to turn on wake word listening.",
    );
  }

  // ---- Open / close -------------------------------------------------------

  function open() {
    if (!inline) chat.hidden = false;
    if (fab) fab.setAttribute("aria-expanded", "true");
    if (!wakeChoiceMade) enableWakeWord();
    refreshContext();
    welcome();
    checkServices();
    scrollToEnd();
    input.focus();
  }

  function close({ restoreFocus = true } = {}) {
    if (!inline && chat.hidden) return;
    if (inline && chat.hidden) return;
    tourActive = false;
    finishTourWait();
    setPending(false);
    stopAudio();
    const hadFocus = chat.contains(document.activeElement);
    if (!inline) chat.hidden = true;
    if (fab) fab.setAttribute("aria-expanded", "false");
    if (restoreFocus && hadFocus && fab) fab.focus();
  }

  if (fab) fab.addEventListener("click", () => (chat.hidden ? open() : close()));
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
