/// Artifact prompt helpers for teaching the model the Conduit artifact contract.
///
/// The model must emit labeled fenced code blocks to create artifacts. Verbal
/// confirmation alone ("Created a new HTML artifact...") does not create one.
/// This module provides the system-level instructions and a lightweight intent
/// detector. The system appendix alone teaches the artifact contract; we no
/// longer inject a per-turn creation developer prompt, since a false-positive
/// intent match there would pressure the model into creating an artifact.
/// Intent is now used only to gate tool visibility and the post-hoc warning.

export const CONDUIT_ARTIFACT_SYSTEM_APPENDIX = [
  'Fenced code blocks in assistant replies render inline in chat first.',
  'Use labeled fences: html/htm, markdown/md, json, text, or a language tag for code.',
  'Put the full body inside the fence; a one-line confirmation without a fence does not create content.',
  'Users promote inline blocks to artifacts when they want editing, preview, or export in the document panel.',
  'Only call write_*_document or edit_*_document when the user explicitly asked to create or revise a document.',
  'For new documents, omit artifact_id — Conduit assigns IDs; do not invent slug-like ids.',
  'Create at most one document per request; after write_*_document returns an artifact_id, revise with edit_*_document — do not call write_* again for the same document.',
  'Answer capability and explanatory questions in prose; do not create or edit artifacts to demonstrate.',
  'When a document artifact is already in scope and the user asks to revise it, prefer edit_*_document over creating a new document.',
  'HTML artifacts render in a sandboxed iframe with no network access (no fetch/XHR). Do not rely on client-side fetching for live data; embed any needed information directly in the artifact. User-clicked http(s) links may open in the system browser after confirmation — emit real href attributes for sources.',
].join(' ');

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
 * Returns true when the user prompt indicates intent to create an artifact.
 * Matches phrases like "create a new artifact html" or "artifact json", but
 * returns false for informational questions ("what is an html artifact?") so
 * they are not misrouted into artifact-creation prompting.
 */
export function looksLikeArtifactCreationRequest(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  if (INFORMATIONAL_QUESTION_PREFIX_REGEX.test(trimmed)) return false;
  return INTENT_REGEX.test(trimmed);
}
