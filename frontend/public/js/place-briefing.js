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

  async function explain() {
    const selection = getSelection();
    if (!selection) {
      setStatus("Select a location on the map first.", true);
      return;
    }
    if (!selection.point && !selection.cell) {
      setStatus("Still loading data for this location; try again in a moment.", true);
      return;
    }

    reset();
    playButton.disabled = true;
    setStatus("Ruby is reading this location…");

    try {
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
      });
      const narration = await response.json();
      if (!response.ok) throw new Error(narration.error || `Briefing failed (${response.status})`);

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
    /** Shows the panel for a usable selection; hides and clears it otherwise. */
    setAvailable(available) {
      panel.hidden = !available;
      if (!available) reset();
    },
    reset,
  };
}
