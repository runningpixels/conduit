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
export function CONDUIT_ARTIFACT_SYSTEM_APPENDIX(toolNames: readonly string[] = []): string {
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
    'HTML artifacts render in a sandboxed iframe with no network access (no fetch/XHR). Do not rely on client-side fetching for live data; embed any needed information directly in the artifact. User-clicked http(s) links may open in the system browser after confirmation — emit real href attributes for sources.',
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
  /\b(create|make|build|generate|write|draft|design|produce|put\s+together)\b.*\b(documents?|web\s?pages?|landing\s+pages?|html\s+pages?|one[- ]pagers?|reports?|guides?|cheat\s?sheets?|infographics?|brochures?|flyers?|newsletters?|html|markdown)\b/i;

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
