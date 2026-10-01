/// Artifact prompt helpers for teaching the model the Conduit artifact contract.
///
/// The model must emit labeled fenced code blocks to create artifacts. Verbal
/// confirmation alone ("Created a new HTML artifact...") does not create one.
/// This module provides the system-level instructions and a lightweight intent
/// detector. The system appendix alone teaches the artifact contract; we no
/// longer inject a per-turn creation developer prompt, since a false-positive
/// intent match there would pressure the model into creating an artifact.
/// Intent is now used only to gate tool visibility and the post-hoc warning.

import { appName } from '../brand';
import type { AppSettings } from '../ipc/contracts';

/// Whether pages written this turn can reach the internet (ADR-010): the
/// Settings switch is on and local-only mode is off. Rust enforces the same.
export function artifactNetworkAvailable(settings: Pick<AppSettings, 'artifactNetworkEnabled' | 'localOnly'>): boolean {
  return settings.artifactNetworkEnabled !== false && !settings.localOnly;
}

/**
 * The artifact contract, for the tools this turn actually offers.
 *
 * It used to name write_*_document, edit_*_document and patch_document on
 * every turn, and they are only offered when the prompt reads as a document
 * request. "Make me a pomodoro timer" and "turn this into a dashboard" do not,
 * so GLM 5.3 Flash was told about tools it had not been given and called them
 * anyway: once as a structured call the loop refused as undeclared (the turn
 * ended in an error, no dashboard), once as its own call markup written into
 * the answer as text (9 kB of page source as prose). Without document tools the
 * appendix says so, and names none.
 */
export function CONDUIT_ARTIFACT_SYSTEM_APPENDIX(
  toolNames: readonly string[] = [],
  options: { network?: boolean } = {},
): string {
  const offersDocumentTools = toolNames.some((name) => /^(write|edit)_\w+_document$|^patch_document$/.test(name));
  return [
    'Fenced code blocks in assistant replies render inline in chat first.',
    'Use labeled fences: html/htm, markdown/md, json, text, or a language tag for code.',
    'Put the full body inside the fence; a one-line confirmation without a fence does not create content.',
    'Users promote inline blocks to artifacts when they want editing, preview, or export in the document panel.',
    ...(offersDocumentTools
      ? [
          'Only call write_*_document or edit_*_document when the user explicitly asked to create or revise a document.',
          `For new documents, omit artifact_id — ${appName()} assigns IDs; do not invent slug-like ids.`,
          'Create at most one document per request; after write_*_document returns an artifact_id, revise with patch_document or edit_*_document — do not call write_* again for the same document.',
        ]
      : ['No document tools are available for this message: write any page, app or document as a single labeled fence in the reply.']),
    'Answer capability and explanatory questions in prose; do not create or edit artifacts to demonstrate.',
    ...(offersDocumentTools
      ? ['When a document artifact is already in scope and the user asks to revise it, prefer patch_document (or edit_*_document for a rewrite) over creating a new document.']
      : []),
    options.network
      ? // ADR-010: fetch() reaches public https APIs once the reader allows each site.
        'HTML artifacts render in a sandboxed iframe. A page may call fetch() to public https APIs that need no key; use an API you know exists and returns what the page needs, and the reader is asked to allow each site first. Declare every site in the head as <meta name="conduit-network" content="api.example.com — why the page needs it">. Handle a refused or failed fetch with a clear message and useful fallback content, never a blank page. Never put API keys or credentials in a page. Images from other sites are blocked; to show one (an avatar, a flag, a poster), fetch() it from a declared site and set the img src to URL.createObjectURL(await response.blob()). XMLHttpRequest, WebSocket, EventSource and remote scripts stay blocked — use fetch() only, and embed data that does not need to be live. User-clicked http(s) links may open in the system browser after confirmation — emit real href attributes for sources.'
      : 'HTML artifacts render in a sandboxed iframe with no network access (no fetch/XHR). Do not rely on client-side fetching for live data; embed any needed information directly in the artifact. User-clicked http(s) links may open in the system browser after confirmation — emit real href attributes for sources.',
    // ADR-012: the sandbox has no ambient storage at all, so a habit tracker
    // or budget app needs the bridge, not the Web Storage APIs it would
    // normally reach for.
    'localStorage, sessionStorage, IndexedDB and cookies do not work in an HTML artifact — the sandbox blocks them. To keep data between launches, declare <meta name="conduit-capability" content="storage — why the page needs it"> and use window.conduit.storage: await window.conduit.storage.get(key) to read, .set(key, jsonValue) to write, .delete(key) to remove one, and .keys(prefix?) to list them — all async, all promises, values must be JSON (at most 1 MB per value, 5 MB total per page). Feature-detect with window.conduit?.storage before calling it, since a page that has not declared the capability has no window.conduit at all.',
    // ADR-013: a page never draws its own settings screen for a handful of
    // launch inputs (a city, units, a currency pair) — Conduit draws the form
    // and hands the values to the page instead.
    `For a few simple launch settings a saved app should ask for (a city, units, a currency pair — never a secret or credential), declare a <script type="application/conduit-inputs+json"> block that is never executed, holding a JSON array of at most 20 objects: { "id": "city", "label": "City", "type": "string", "default": "Paris", "required": true }. type is one of string (up to 500 characters), number, boolean, enum (add "options": [...], 1-50 short strings) or date ("YYYY-MM-DD"); id is 1-40 characters of letters, digits, - and _, unique per page; label is shown in the form ${appName()} draws. Read the current values from window.conduit.inputs (a plain frozen object keyed by id) once at start, and listen for window.addEventListener("conduit:inputs-changed", e => ...) to react when the reader changes them later — e.detail holds the new values, and the page never reloads for this. window.conduit.inputs is only present once the page is saved as an app and the reader has values for it; feature-detect with window.conduit?.inputs and fall back to the declared defaults (or the page's own hardcoded ones) when it is absent, which is normal in a chat preview.`,
    // ADR-014: a page that wants to summarize, classify, or generate short
    // text from what the user typed into it can ask the user's own model,
    // rather than shipping its own API key or going without.
    'To ask the user\'s own AI model a question from inside a page (summarize some text, classify input, draft a short reply — never a secret or credential), declare <meta name="conduit-capability" content="llm — why the page needs it"> and call await window.conduit.llm.complete({ prompt, system, maxTokens, json }), which resolves to { text }. prompt is required and must be a non-empty string; system, maxTokens (default 1024, max 2048) and json (true to ask for a JSON-only reply) are optional. This is a single text-in, text-out call with no tools, no chat history and no memory of earlier calls — not a conversation. The reader is asked to allow it the first time, naming the provider and whether the call leaves the device; a page must feature-detect with window.conduit?.llm (absent without the declared capability) and handle a rejected promise (e.code is one of not_granted, unavailable, rate_limited, invalid or timeout) with a clear fallback, since the reader may decline. Pass slot: \'quick\' for short, cheap calls (a label, a one-line summary); leave it out otherwise. Keep prompts short and specific — there is no way to send it more context than the prompt and system strings carry.',
  ].join(' ');
}

/** Wh-questions and "tell me about / explain" are informational regardless of
 * which keywords appear later. Phrased-as-a-question ability requests such as
 * "can you create an artifact?" are NOT informational (they start with "can you")
 * and should still route to creation. Keep this narrow: the broad interrogative
 * set lives in documentTurnIntent for the info classifier, which defers to this
 * function, so adding words here would re-introduce the misroute we fixed. */
const INFORMATIONAL_QUESTION_PREFIX_REGEX =
  /^(what|which|how|why|when|where|who|tell me about|explain)\b/i;

const INTENT_REGEX =
  /\b(create|make|new|generate)\b.*\bartifact\b|\bartifact\b.*\b(html|markdown|json|code|text)\b/i;

/**
 * A creation verb followed by something that is plainly a document. Without
 * this, "Create an HTML document titled …" never mentioned "artifact", got no
 * document tools, and the model wrote a workspace file instead — three minutes
 * with no document panel. Plain writing requests with no document noun
 * ("write a poem", "draft an email") stay general.
 */
const DOCUMENT_CREATION_REGEX =
  /\b(create|make|build|generate|write|draft|design|produce|put\s+together|turn\b.*\binto)\b.*\b(documents?|web\s?pages?|landing\s+pages?|html\s+pages?|one[- ]pagers?|reports?|guides?|cheat\s?sheets?|infographics?|brochures?|flyers?|newsletters?|html|markdown|dashboards?|(web\s?)?apps?|games?|calculators?|converters?|timers?|trackers?|viewers?|explorers?|monitors?|checkers?|finders?|lookups?|tickers?|quiz(zes)?|flash\s?cards?|visuali[sz]ations?|simulators?|animations?|spinners?|widgets?|kanban|sortable\s+tables?|interactive\s+\w+|pitch\s+decks?|slide\s?decks?|presentations?|templates?|websites?|forms?)\b/i;
/* The second half used to stop at document nouns. "Make a weather dashboard",
 * "make this a sortable table" and "make me a CSS-only loading spinner" were
 * then general turns without document tools, and GLM called one anyway — a
 * call the provider swallowed whole, so each reply was its intro sentence and
 * nothing else (1,200 output tokens generated, 20 delivered). Offered the
 * tools, the same model wrote these through them without trouble. */

/**
 * Returns true when the user prompt indicates intent to create an artifact.
 * Matches phrases like "create a new artifact html" or "artifact json", but
 * returns false for informational questions ("what is an html artifact?") so
 * they are not misrouted into artifact-creation prompting.
 */
export function looksLikeArtifactCreationRequest(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  if (INFORMATIONAL_QUESTION_PREFIX_REGEX.test(trimmed)) return false;
  return INTENT_REGEX.test(trimmed) || DOCUMENT_CREATION_REGEX.test(trimmed);
}
