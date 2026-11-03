// Ruby, the floating assistant. Add this to any page with one tag:
//
//   <script type="module" src="./js/ruby-assistant.js"></script>
//
// It injects its own stylesheet and markup (a round mascot button at the bottom
// right that opens the chat), so a page needs nothing else. A page that has a
// selected place can tell Ruby about it by defining
//
//   window.MarsWalkRuby = { getSelection: () => ({ ... }) }
//
// and can call window.RubyAssistant.refreshContext() when that selection changes.

import { initRubyWidget } from "./ruby-widget.js";

const MASCOT_URL = new URL("../assets/ruby-mascot.webp", import.meta.url).href;
const STYLESHEET_URL = new URL("../css/ruby-assistant.css", import.meta.url).href;

// Static markup only: nothing from the network or the page is interpolated into
// it except the two URLs above, which are built from this module's own address.
const GEM_SVG =
  '<svg class="ruby-gem" viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
  '<path d="M14 8h20l9 12-19 21L5 20z" fill="currentColor" opacity=".25"/>' +
  '<path d="M14 8h20l9 12-19 21L5 20zM5 20h38M17 20l7 21 7-21M14 8l3 12M34 8l-3 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
  "</svg>";

function markup(mascotUrl) {
  return `
<button type="button" class="ruby-fab" id="ruby-fab" aria-label="Ask Ruby, the Mars assistant" title="Ask Ruby" aria-haspopup="dialog" aria-expanded="false" aria-controls="ruby-chat">
  <img class="ruby-fab-img" src="${mascotUrl}" alt="" width="64" height="64" decoding="async" draggable="false" />
  ${GEM_SVG}
</button>
<section class="ruby-chat" id="ruby-chat" role="dialog" aria-modal="false" aria-labelledby="ruby-chat-title" hidden>
  <header class="ruby-chat-head">
    <span class="ruby-chat-avatar" aria-hidden="true">
      <img class="ruby-fab-img" src="${mascotUrl}" alt="" width="38" height="38" decoding="async" draggable="false" />
      ${GEM_SVG}
    </span>
    <div class="ruby-chat-titles">
      <h2 id="ruby-chat-title">Ruby</h2>
      <p class="ruby-chat-context" id="ruby-chat-context">Mars assistant</p>
    </div>
    <button type="button" class="ruby-icon-button" id="ruby-chat-voice" aria-pressed="false" aria-label="Speak Ruby's replies aloud" title="Speak replies">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4z" fill="currentColor"/><path class="ruby-voice-waves" d="M15 9a4 4 0 0 1 0 6M17.5 6.5a8 8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <button type="button" class="ruby-icon-button" id="ruby-chat-close" aria-label="Close Ruby" title="Close">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>
  </header>
  <div class="ruby-chat-log" id="ruby-chat-log" role="log" aria-live="polite" aria-label="Conversation with Ruby"></div>
  <div class="ruby-chat-chips" id="ruby-chat-chips" aria-label="Suggested questions"></div>
  <form class="ruby-chat-form" id="ruby-chat-form" autocomplete="off">
    <label class="ruby-visually-hidden" for="ruby-chat-input">Ask Ruby a question</label>
    <input id="ruby-chat-input" type="text" maxlength="500" placeholder="Ask about Mars or this place…" enterkeyhint="send" />
    <button type="button" class="ruby-icon-button" id="ruby-chat-mic" aria-pressed="false" aria-label="Ask by voice" title="Ask by voice" hidden>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
    </button>
    <button type="submit" class="ruby-send" id="ruby-chat-send">Send</button>
  </form>
  <p class="ruby-chat-note" id="ruby-chat-note">Answers come from MarsWalk's map data first. Anything else is answered by an AI model, which can be wrong.</p>
</section>`;
}

function loadStylesheet() {
  if (document.querySelector("link[data-ruby-assistant]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLESHEET_URL;
  link.dataset.rubyAssistant = "";
  document.head.append(link);
}

/** If the mascot file is missing or broken, show a plain gem instead of a broken-image icon. */
function guardImages(root) {
  root.querySelectorAll(".ruby-fab-img").forEach((img) => {
    const fallback = () => img.parentElement?.classList.add("is-fallback");
    img.addEventListener("error", fallback, { once: true });
    if (img.complete && img.naturalWidth === 0) fallback();
  });
}

function mount() {
  if (window.RubyAssistant || document.getElementById("ruby-fab")) return;

  loadStylesheet();

  // On pages that already embed the chat panel (e.g. map.html has it inside
  // #assistant-panel), only inject the FAB button. The chat markup is already
  // in the DOM and ruby-widget.js will find it by its element IDs.
  const chatAlreadyInPage = Boolean(document.getElementById("ruby-chat-form"));

  if (chatAlreadyInPage) {
    const fab = document.createElement("button");
    fab.type = "button";
    fab.className = "ruby-fab";
    fab.id = "ruby-fab";
    fab.setAttribute("aria-label", "Ask Ruby, the Mars assistant");
    fab.title = "Ask Ruby";
    fab.setAttribute("aria-haspopup", "dialog");
    fab.setAttribute("aria-expanded", "false");
    fab.setAttribute("aria-controls", "ruby-chat");
    fab.innerHTML =
      `<img class="ruby-fab-img" src="${MASCOT_URL}" alt="" width="64" height="64" decoding="async" draggable="false" />${GEM_SVG}`;
    document.body.append(fab);
  } else {
    const holder = document.createElement("div");
    holder.innerHTML = markup(MASCOT_URL);
    document.body.append(...holder.children);
  }

  guardImages(document.body);

  // The Jezero 3D page keeps its movement pad in the bottom-right corner.
  if (document.querySelector(".touch-pad")) document.documentElement.classList.add("ruby-lift");

  window.RubyAssistant = initRubyWidget({
    getSelection: () => {
      try {
        return window.MarsWalkRuby?.getSelection?.() ?? null;
      } catch {
        return null;
      }
    },
    hasSelectionSource: () => typeof window.MarsWalkRuby?.getSelection === "function",
    inline: chatAlreadyInPage,
  });
}

if (document.body) mount();
else document.addEventListener("DOMContentLoaded", mount, { once: true });
