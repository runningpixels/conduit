/// Artifact prompt helpers for teaching the model the Conduit artifact contract.
///
/// The model must emit labeled fenced code blocks to create artifacts. Verbal
/// confirmation alone ("Created a new HTML artifact...") does not create one.
/// This module provides the system-level instructions, a lightweight intent
/// detector, and an optional per-request developer prompt for reinforcement.

export const CONDUIT_ARTIFACT_SYSTEM_APPENDIX = [
  'Artifacts are created from fenced code blocks in the assistant reply.',
  'Use labeled fences: html/htm, markdown/md, json, text, or a language tag for code.',
  'Put the full artifact body inside the fence; a one-line confirmation without a fence does not create an artifact.',
  'Conduit auto-opens the first promotable fence when the stream completes.',
].join(' ');

const INTENT_REGEX =
  /\b(create|make|new|generate)\b.*\bartifact\b|\bartifact\b.*\b(html|markdown|json|code|text)\b/i;

/**
 * Returns true when the user prompt indicates intent to create an artifact.
 * Matches phrases like "create a new artifact html" or "artifact json".
 */
export function looksLikeArtifactCreationRequest(prompt: string): boolean {
  return INTENT_REGEX.test(prompt);
}

/**
 * Returns a short developer prompt to reinforce the fence requirement when
 * an artifact creation request is detected. Undefined otherwise.
 */
export function artifactDeveloperPromptFor(userPrompt: string): string | undefined {
  if (!looksLikeArtifactCreationRequest(userPrompt)) return undefined;
  return 'The user asked for an artifact. Your reply MUST include a complete fenced code block (```html … ``` or similar) with the full content.';
}
