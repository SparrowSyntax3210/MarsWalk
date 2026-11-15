// Spoken route briefing. Sends the calculated route to Ruby, shows the text,
// and plays it in her voice.
//
// The backend owns all phrasing and arithmetic (see
// backend/src/services/route-narration.js) so the spoken figures cannot drift
// from the ones on screen. This module only gathers UI-owned context, renders
// the reply, and speaks it with the visitor's browser system voice.

import { cancelRubySpeech, speakRubyText } from "./ruby-speech.js";

/** Reads a numeric input without throwing; returns null when unusable. */
function optionalNumber(id) {
  const element = document.getElementById(id);
  if (!element) return null;
  const value = Number(element.value);
  return Number.isFinite(value) ? value : null;
}

/** Mission Planner fields are optional here: absent ones simply go unmentioned. */
function missionContext() {
  const crewed = document.getElementById("mission-profile")?.value === "crewed";
  return {
    profile: crewed ? "crewed" : "robotic",
    energyKwhPerKm: optionalNumber("mission-energy-rate"),
    energyBudgetKwh: optionalNumber("mission-energy-budget"),
    reservePct: optionalNumber("mission-energy-reserve"),
    crewSize: crewed ? optionalNumber("mission-crew-size") : null,
    oxygenBudgetKg: crewed ? optionalNumber("mission-oxygen-budget") : null,
    oxygenKgPerPersonSol: crewed ? optionalNumber("mission-oxygen-rate") : null,
    maxSols: optionalNumber("mission-max-sols"),
    maxDistanceKm: optionalNumber("mission-max-distance"),
    maxSlopeDeg: optionalNumber("mission-max-slope"),
    roughnessLimitM: optionalNumber("mission-roughness-limit"),
  };
}

export function initRouteBriefing({ getRoute, getContext }) {
  const button = document.getElementById("route-explain-button");
  const panel = document.getElementById("route-briefing");
  const textEl = document.getElementById("route-briefing-text");
  const moreButton = document.getElementById("route-briefing-more");
  const statusEl = document.getElementById("route-briefing-status");
  if (!button || !panel) return { setEnabled() {}, reset() {} };

  let pendingDetail = null;

  function setStatus(message, isError = false) {
    statusEl.textContent = message || "";
    statusEl.classList.toggle("is-error", Boolean(isError));
  }

  function stopAudio() {
    cancelRubySpeech();
  }

  function reset() {
    stopAudio();
    pendingDetail = null;
    panel.hidden = true;
    textEl.textContent = "";
    moreButton.hidden = true;
    setStatus("");
  }

  /** Speaks one utterance with the visitor's browser/operating-system voice. */
  async function speak(text) {
    if (!text) return;
    try {
      stopAudio();
      setStatus("Speaking with this device's system voice.");
      await speakRubyText(text);
    } catch (error) {
      // The briefing text is already on screen, so this is not fatal.
      setStatus(`Voice unavailable: ${error.message}`, true);
    }
  }

  async function explain() {
    const route = getRoute();
    if (!route) {
      setStatus("Calculate a route first.", true);
      return;
    }

    reset();
    panel.hidden = false;
    button.disabled = true;
    setStatus("Ruby is reading the route…");

    try {
      const response = await fetch("/api/ruby/narrate/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          route,
          context: { ...missionContext(), ...getContext() },
        }),
      });
      const narration = await response.json();
      if (!response.ok) throw new Error(narration.error || `Briefing failed (${response.status})`);

      textEl.textContent = narration.text;
      // Anything flagged as needing attention gets visual emphasis too.
      panel.classList.toggle("has-warning", Boolean(narration.warnings));
      pendingDetail = narration.detail || null;
      moreButton.hidden = !pendingDetail;
      await speak(narration.summary);
    } catch (error) {
      textEl.textContent = "";
      setStatus(error.message, true);
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener("click", explain);
  moreButton.addEventListener("click", async () => {
    if (!pendingDetail) return;
    moreButton.hidden = true;
    await speak(pendingDetail);
  });

  return {
    setEnabled(enabled) {
      button.disabled = !enabled;
      if (!enabled) reset();
    },
    reset,
  };
}
