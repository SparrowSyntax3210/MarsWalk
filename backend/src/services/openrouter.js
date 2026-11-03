// Minimal OpenRouter chat client for Ruby's "everything else" answers.
//
// Security notes:
//   * The API key is read here, on the server, and never returned to a browser.
//   * It is read from the environment or from OPENROUTER_* entries in the
//     project .env only. The rest of .env (HOST, PORT) is deliberately NOT
//     loaded into process.env: nothing in this app loaded it before, and doing
//     so now could silently change the port the server binds to.
//   * Provider error bodies are logged server-side without the key and are
//     never forwarded to the client.
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const ENV_PATH = path.resolve(__dirname, "../../../.env");
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
// Static emergency list; normally refreshes the live OpenRouter free catalog.
const DEFAULT_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "cohere/north-mini-code:free",
  "google/gemma-4-31b-it:free",
];
// Measured on the free models with a real prompt: answers normally take 0.3 to
// 5 seconds, but a model occasionally stalls (one took the full 25 s timeout
// before the next model answered in 2 s). So each model gets a short window,
// and the whole attempt has a budget, rather than waiting on one that is stuck.
const PER_MODEL_TIMEOUT_MS = 10_000;
const TOTAL_BUDGET_MS = 28_000;
// A local app: this is a cost guard, not auth. Adjustable for tests and for
// accounts with higher limits.
const MAX_CALLS_PER_MINUTE = Number(process.env.OPENROUTER_MAX_CALLS_PER_MINUTE) > 0
  ? Number(process.env.OPENROUTER_MAX_CALLS_PER_MINUTE)
  : 15;
const FREE_CATALOG_TTL_MS = 10 * 60_000;
let freeCatalog = { expiresAt: 0, models: [] };
let nextModelIndex = 0;

async function getFreeModels(config) {
  if (freeCatalog.expiresAt > Date.now() && freeCatalog.models.length) return freeCatalog.models;
  try {
    const response = await fetch(`${config.baseUrl}/models`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
    const payload = await response.json();
    const ids = (payload.data || []).map((model) => model.id).filter((id) => typeof id === "string" && id.endsWith(":free"));
    if (ids.length) {
      freeCatalog = { expiresAt: Date.now() + FREE_CATALOG_TTL_MS, models: ids };
      return ids;
    }
  } catch (error) {
    console.warn(`OpenRouter free model catalog unavailable; using cached/default list: ${error.message}`);
  }
  return freeCatalog.models.length ? freeCatalog.models : DEFAULT_MODELS;
}

class OpenRouterError extends Error {
  /** @param {"not_configured"|"unauthorized"|"forbidden"|"no_credits"|"rate_limited"|"timeout"|"unavailable"|"empty"|"bad_response"} code */
  constructor(code, message) {
    super(message);
    this.name = "OpenRouterError";
    this.code = code;
  }
}

/**
 * Reads settings on every call, so adding a key to .env takes effect without
 * restarting the server. The file is tiny.
 */
function readConfig() {
  let fileValues = {};
  try {
    fileValues = dotenv.parse(fs.readFileSync(ENV_PATH));
  } catch {
    // No .env is fine; the environment may carry the settings instead.
  }
  const pick = (name) => String(process.env[name] ?? fileValues[name] ?? "").trim();

  const configuredModels = pick("OPENROUTER_MODEL")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  return {
    // OPEN_ROUTER_KEY is accepted too: it is the name already used in this
    // project's .env, and renaming a secret is not worth a support round-trip.
    apiKey: pick("OPENROUTER_API_KEY") || pick("OPEN_ROUTER_KEY"),
    baseUrl: (pick("OPENROUTER_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    models: configuredModels,
    referer: pick("OPENROUTER_REFERER") || "http://localhost:5000",
  };
}

/** Safe to expose to the browser: says whether AI is on, never the key. */
function status() {
  const config = readConfig();
  return { configured: Boolean(config.apiKey), models: config.models.length ? config.models : freeCatalog.models.length ? freeCatalog.models : DEFAULT_MODELS };
}

// Sliding one-minute window.
const callTimes = [];
function takeRateSlot(now = Date.now()) {
  while (callTimes.length && now - callTimes[0] > 60_000) callTimes.shift();
  if (callTimes.length >= MAX_CALLS_PER_MINUTE) return false;
  callTimes.push(now);
  return true;
}

function errorFromStatus(httpStatus) {
  if (httpStatus === 401) return new OpenRouterError("unauthorized", "OpenRouter rejected the API key.");
  // 403 is about one model (for example "only available on agentic harnesses"),
  // not the key, so the next model is still worth trying.
  if (httpStatus === 403) return new OpenRouterError("forbidden", "OpenRouter refused this model for this account.");
  if (httpStatus === 402) return new OpenRouterError("no_credits", "The OpenRouter account has no credits for this model.");
  if (httpStatus === 429) return new OpenRouterError("rate_limited", "OpenRouter rate limit reached.");
  return new OpenRouterError("unavailable", `OpenRouter returned HTTP ${httpStatus}.`);
}

/** Failures worth retrying on the next model. A bad key fails every model. */
const RETRY_NEXT_MODEL = new Set(["rate_limited", "forbidden", "timeout", "unavailable", "empty", "bad_response"]);

async function callModel(config, model, messages, { maxTokens, temperature, timeoutMs }) {
  let response;
  try {
    response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.referer,
        "X-Title": "MarsWalk",
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      throw new OpenRouterError("timeout", "OpenRouter did not answer in time.");
    }
    throw new OpenRouterError("unavailable", `Could not reach OpenRouter: ${error.cause?.code || error.message}`);
  }

  if (!response.ok) throw errorFromStatus(response.status);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new OpenRouterError("bad_response", "OpenRouter returned something that was not JSON.");
  }

  // OpenRouter can report a provider failure inside an HTTP 200 body.
  if (payload?.error) {
    const code = Number(payload.error.code);
    throw Number.isFinite(code) && code >= 400 ? errorFromStatus(code) : new OpenRouterError("unavailable", "The model provider reported an error.");
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    // Reasoning-heavy models can spend the whole token budget thinking.
    throw new OpenRouterError("empty", "The model returned no text.");
  }
  return { text: content.trim(), model: payload.model || model };
}

/**
 * Sends a chat request, trying each configured model in turn.
 *
 * @param {{system: string, messages: {role: "user"|"assistant", content: string}[],
 *          maxTokens?: number, temperature?: number}} request
 * @returns {Promise<{text: string, model: string}>}
 * @throws {OpenRouterError}
 */
// maxTokens is generous on purpose. Several free models are "thinking" models
// that spend most of the budget on hidden reasoning before the first word of the
// answer (620 of 667 tokens in one measurement), and a small cap leaves them
// with empty text. The prompt, not this cap, keeps the answers short.
async function chat({ system, messages, maxTokens = 1000, temperature = 0.4 }) {
  const config = readConfig();
  if (!config.apiKey) throw new OpenRouterError("not_configured", "No OpenRouter API key is set.");
  if (!takeRateSlot()) throw new OpenRouterError("rate_limited", "Ruby's AI helper is being asked too quickly.");

  const payloadMessages = [{ role: "system", content: system }, ...messages];
  let lastError = null;
  const startedAt = Date.now();
  const models = config.models.length ? config.models : await getFreeModels(config);
  // Start successive requests at different models so a hot or throttled
  // provider does not receive every first attempt. On failure, walk the rest.
  const start = nextModelIndex++ % models.length;
  const orderedModels = models.slice(start).concat(models.slice(0, start));
  for (const model of orderedModels) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remaining < 2_000) break; // not enough left for another model to answer
    try {
      return await callModel(config, model, payloadMessages, {
        maxTokens,
        temperature,
        timeoutMs: Math.min(PER_MODEL_TIMEOUT_MS, remaining),
      });
    } catch (error) {
      if (!(error instanceof OpenRouterError)) throw error;
      lastError = error;
      // Log the reason, never the key or the provider's body.
      console.error(`OpenRouter model ${model} failed: ${error.code}`);
      if (!RETRY_NEXT_MODEL.has(error.code)) break;
    }
  }
  throw lastError || new OpenRouterError("timeout", "OpenRouter did not answer within the time budget.");
}

module.exports = { chat, status, OpenRouterError };
