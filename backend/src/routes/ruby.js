const express = require("express");
const { askRuby } = require("../services/ruby-brain");
const { extractRouteFacts, narrateRoute } = require("../services/route-narration");
const { extractPointFacts, narratePoint } = require("../services/point-narration");
const openrouter = require("../services/openrouter");

const router = express.Router();

// Local voice server: python/ruby_voice/sovits_server.py (fine-tuned
// GPT-SoVITS). Hindi auditioning uses speak_hindi.py offline instead.
const VOICE_SERVER_URL = process.env.RUBY_VOICE_URL || "http://127.0.0.1:5055";
const MAX_MESSAGE_LENGTH = 500;
const MAX_SPEECH_LENGTH = 600;
const SPEECH_TIMEOUT_MS = 120_000;

function readText(body, field, maxLength) {
  const value = body?.[field];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const clipText = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : null);
const finiteOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * Keeps only the fields Ruby reads from the browser's selection, with sizes
 * capped. The selection ends up inside a language-model prompt, so it is
 * treated as untrusted input rather than passed through.
 */
function sanitizeSelection(raw) {
  if (!isPlainObject(raw)) return null;
  const cleanFeature = (feature) =>
    isPlainObject(feature)
      ? { name: clipText(feature.name, 120), type: clipText(feature.type, 80), diameterKm: finiteOrNull(feature.diameterKm) }
      : null;
  const point = isPlainObject(raw.point) && Array.isArray(raw.point.layers) ? raw.point : null;
  const cell = isPlainObject(raw.cell) && isPlainObject(raw.cell.cell) ? raw.cell : null;
  return {
    lat: finiteOrNull(raw.lat),
    lon: finiteOrNull(raw.lon),
    title: clipText(raw.title, 120),
    feature: cleanFeature(raw.feature),
    region: isPlainObject(raw.region)
      ? { name: clipText(raw.region.name, 120), tagline: clipText(raw.region.tagline, 200) }
      : null,
    nearest: isPlainObject(raw.nearest)
      ? {
          name: clipText(raw.nearest.name, 120),
          distanceKm: finiteOrNull(raw.nearest.distanceKm),
          bearingDeg: finiteOrNull(raw.nearest.bearingDeg),
          inside: Boolean(raw.nearest.inside),
        }
      : null,
    point,
    cell,
    status: raw.status === "loading" ? "loading" : "ready",
  };
}

router.post("/ask", async (req, res, next) => {
  const message = readText(req.body, "message", MAX_MESSAGE_LENGTH);
  if (!message) {
    return res.status(400).json({ error: `A message of 1 to ${MAX_MESSAGE_LENGTH} characters is required.` });
  }
  try {
    return res.json(
      await askRuby(message, {
        selection: sanitizeSelection(req.body?.selection),
        history: req.body?.history,
      }),
    );
  } catch (error) {
    return next(error);
  }
});

// Whether the language-model fallback is available. Never includes the key.
router.get("/ai-status", (_req, res) => {
  const { configured, models } = openrouter.status();
  res.json({ configured, model: configured ? models[0] : null });
});

// Narrates a calculated route. The client posts the planner payload it already
// holds, plus the traverse assumptions and nearby place names the UI owns, and
// gets back speech-ready text. Returned as summary/detail so the caller can
// speak the short part immediately: /speak caps a single utterance at
// MAX_SPEECH_LENGTH characters.
router.post("/narrate/route", (req, res) => {
  const payload = req.body?.route;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return res.status(400).json({ error: "Send { route: <planner payload> } to narrate." });
  }
  if (!payload.metrics || typeof payload.metrics !== "object") {
    return res.status(400).json({ error: "The route payload has no metrics to describe." });
  }

  const context = req.body?.context;
  try {
    const facts = extractRouteFacts(payload, context && typeof context === "object" ? context : {});
    const narration = narrateRoute(facts);
    if (!narration.text) {
      return res.status(422).json({ error: "There was nothing describable in that route payload." });
    }
    return res.json({ ...narration, facts });
  } catch (error) {
    console.error("Route narration failed:", error.message);
    return res.status(500).json({ error: "Ruby could not describe that route." });
  }
});

// Describes a selected Explore location. The client posts the /api/point and
// /api/cell payloads it already fetched, so this adds no extra lookups.
// Returns a short summary plus labelled sections, since a full description of
// a location runs past the single-utterance limit of /speak.
router.post("/narrate/point", (req, res) => {
  const { point, cell, context } = req.body || {};
  const usablePoint = point && typeof point === "object" && !Array.isArray(point);
  const usableCell = cell && typeof cell === "object" && !Array.isArray(cell);
  if (!usablePoint && !usableCell) {
    return res.status(400).json({ error: "Send { point, cell } payloads for a selected location." });
  }

  try {
    const facts = extractPointFacts(
      { point: usablePoint ? point : null, cell: usableCell ? cell : null },
      context && typeof context === "object" ? context : {},
    );
    const narration = narratePoint(facts);
    if (!narration.summary) {
      return res.status(422).json({ error: "There was nothing describable about that location." });
    }
    return res.json({ ...narration, facts });
  } catch (error) {
    console.error("Point narration failed:", error.message);
    return res.status(500).json({ error: "Ruby could not describe that location." });
  }
});

router.get("/voice-status", async (_req, res) => {
  try {
    const response = await fetch(`${VOICE_SERVER_URL}/health`, { signal: AbortSignal.timeout(3_000) });
    const payload = await response.json();
    return res.json({ online: response.ok, ...payload });
  } catch {
    return res.json({ online: false });
  }
});

router.post("/speak", async (req, res) => {
  const text = readText(req.body, "text", MAX_SPEECH_LENGTH);
  if (!text) {
    return res.status(400).json({ error: `Text of 1 to ${MAX_SPEECH_LENGTH} characters is required.` });
  }

  try {
    const response = await fetch(`${VOICE_SERVER_URL}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Voice server returned HTTP ${response.status}`);
    }
    const audio = Buffer.from(await response.arrayBuffer());
    res.set({ "Content-Type": "audio/wav", "Cache-Control": "no-store" });
    return res.send(audio);
  } catch (error) {
    console.error("Ruby voice synthesis failed:", error.message);
    return res.status(503).json({
      error: "Ruby's voice server is not available. Start python/ruby_voice/sovits_server.py and try again.",
    });
  }
});

module.exports = router;
