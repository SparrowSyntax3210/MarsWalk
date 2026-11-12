// Spoken briefing for the selected Explore location.
//
// The backend owns all phrasing and every figure (see
// backend/src/services/point-narration.js). This module gathers the payloads
// the panel already fetched, renders the reply, and offers each topic as its
// own short utterance, because a full description of a place runs well past
// the single-utterance limit of /api/ruby/speak.

const MAX_SPEECH_LENGTH = 600; // must match /api/ruby/speak

export function initPlaceBriefing({ getSelection }) {
  const panel = document.getElementById("place-briefing");
  const playButton = document.getElementById("place-briefing-play");
  const textEl = document.getElementById("place-briefing-text");
  const topicsEl = document.getElementById("place-briefing-topics");
  const statusEl = document.getElementById("place-briefing-status");
  if (!panel || !playButton) return { setAvailable() {}, reset() {} };

  let currentAudio = null;
  let sections = [];

  function setStatus(message, isError = false) {
    statusEl.textContent = message || "";
    statusEl.classList.toggle("is-error", Boolean(isError));
  }

  function stopAudio() {
    if (!currentAudio) return;
    currentAudio.pause();
    currentAudio = null;
  }

  function reset() {
    stopAudio();
    sections = [];
    textEl.textContent = "";
    topicsEl.replaceChildren();
    setStatus("");
    playButton.textContent = "Explain this place";
  }

  async function speak(text, label) {
    if (!text) return;
    if (text.length > MAX_SPEECH_LENGTH) {
      setStatus(`${label} is too long to speak in one go; the text is shown above.`);
      return;
    }
    try {
      setStatus(`Generating Ruby's voice for ${label.toLowerCase()}…`);
      const response = await fetch("/api/ruby/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Voice request failed (${response.status})`);
      }
      const url = URL.createObjectURL(await response.blob());
      stopAudio();
      currentAudio = new Audio(url);
      currentAudio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
      await currentAudio.play();
      setStatus(`Speaking: ${label.toLowerCase()}.`);
    } catch (error) {
      // The text is already on screen, so a voice failure is not fatal.
      setStatus(`Voice unavailable: ${error.message}`, true);
    }
  }

  /** One button per topic, so each stays within the single-utterance limit. */
  function renderTopics() {
    topicsEl.replaceChildren(
      ...sections.map((section) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "place-briefing-topic";
        button.textContent = section.label;
        button.addEventListener("click", async () => {
          textEl.textContent = section.text;
          topicsEl
            .querySelectorAll(".place-briefing-topic")
            .forEach((node) => node.classList.toggle("is-active", node === button));
          await speak(section.text, section.label);
        });
        return button;
      }),
    );
  }

  async function loadSelectedPointNarration({ signal } = {}) {
    let selection = getSelection();
    if (!selection) throw new Error("Select a location on the map first.");
    for (let attempt = 0; selection.status === "loading" && attempt < 20; attempt += 1) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 250);
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(new DOMException("Request aborted", "AbortError"));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
      selection = getSelection();
    }
    if (!selection || !Number.isFinite(selection.lat) || !Number.isFinite(selection.lon)) {
      throw new Error("I can’t read the selected map point. Select a point on the Explore map and try again.");
    }

    if (!selection.point || !selection.cell) {
      const query = new URLSearchParams({ lat: String(selection.lat), lon: String(selection.lon) });
      const retry = async (path) => {
        const response = await fetch(`${path}?${query}`, { signal });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Map lookup failed (${response.status}).`);
        return payload;
      };
      const [pointResult, cellResult] = await Promise.allSettled([
        selection.point ? Promise.resolve(selection.point) : retry("/api/point"),
        selection.cell ? Promise.resolve(selection.cell) : retry("/api/cell"),
      ]);
      selection = {
        ...selection,
        point: pointResult.status === "fulfilled" ? pointResult.value : null,
        cell: cellResult.status === "fulfilled" ? cellResult.value : null,
      };
    }
    if (!selection.point && !selection.cell) {
      throw new Error("The selected point’s terrain services are unavailable right now. Please try again shortly.");
    }

    const response = await fetch("/api/ruby/narrate/point", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        point: selection.point || null,
        cell: selection.cell || null,
        context: {
          lat: selection.lat,
          lon: selection.lon,
          title: selection.title,
          feature: selection.feature,
          region: selection.region,
          nearest: selection.nearest,
        },
      }),
      signal,
    });
    const narration = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(narration.error || `Briefing failed (${response.status}).`);
    return narration;
  }

  async function explain() {
    reset();
    playButton.disabled = true;
    setStatus("Ruby is reading this location…");

    try {
      const narration = await loadSelectedPointNarration();

      textEl.textContent = narration.summary;
      sections = narration.sections || [];
      renderTopics();
      playButton.textContent = "Explain again";
      await speak(narration.summary, "Overview");
    } catch (error) {
      textEl.textContent = "";
      setStatus(error.message, true);
    } finally {
      playButton.disabled = false;
    }
  }

  playButton.addEventListener("click", explain);

  return {
    explainSelectedPoint: loadSelectedPointNarration,
    /** Shows the panel for a usable selection; hides and clears it otherwise. */
    setAvailable(available) {
      panel.hidden = !available;
      if (!available) reset();
    },
    reset,
  };
}
