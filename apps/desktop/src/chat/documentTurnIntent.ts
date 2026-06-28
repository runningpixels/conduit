import { looksLikeArtifactCreationRequest } from './artifactPrompt';

/** How the current user turn relates to document artifact tools. */
export type DocumentTurnIntent = 'info' | 'create' | 'edit' | 'general';

const EDIT_FOLLOW_UP_REGEX =
  /\b(edit|update|change|modify|revise|rewrite|adjust|improve|fix|tweak|dark\s*mode|light\s*mode|add|remove|make\s+it|turn\s+it|convert)\b/i;

const INFORMATIONAL_PREFIX_REGEX =
  /^(what|which|how|why|when|where|who|can you|could you|do you|does|are|is|tell me about)\b/i;

/** Document capability questions that mention edit/create but are not edit requests. */
function looksLikeDocumentCapabilityQuestion(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed.endsWith('?')) return false;
  if (!/^(can you|could you|do you|what|which|how)\b/i.test(trimmed)) return false;
  if (/\b(header|title|section|footer|color|style|page|body|dark\s*mode|light\s*mode)\b/i.test(trimmed)) {
    return false;
  }
  return /\b(html|markdown|text|document|artifact|export)\b/i.test(trimmed);
}

/** True when the prompt reads like a follow-up edit to an existing document. */
export function looksLikeArtifactEditFollowUp(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  if (looksLikeArtifactCreationRequest(trimmed)) return false;
  if (looksLikeDocumentCapabilityQuestion(trimmed)) return false;
  return EDIT_FOLLOW_UP_REGEX.test(trimmed);
}

/**
 * True when the user is asking for information rather than requesting document
 * mutation. Edit/create intent takes precedence so "can you update the header?"
 * is not treated as informational.
 */
export function looksLikeInformationalQuestion(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;
  if (looksLikeArtifactEditFollowUp(trimmed)) return false;
  if (looksLikeArtifactCreationRequest(trimmed)) return false;
  if (INFORMATIONAL_PREFIX_REGEX.test(trimmed)) return true;
  return trimmed.endsWith('?');
}

/**
 * Classify the user's turn for document-tool routing and prompt injection.
 */
export function classifyDocumentTurnIntent(prompt: string): DocumentTurnIntent {
  const trimmed = prompt.trim();
  if (!trimmed) return 'general';
  if (looksLikeArtifactCreationRequest(trimmed)) return 'create';
  if (looksLikeArtifactEditFollowUp(trimmed)) return 'edit';
  if (looksLikeInformationalQuestion(trimmed)) return 'info';
  return 'general';
}

/** Short developer reinforcement for informational turns. */
export function informationalDeveloperPromptFor(userPrompt: string): string | undefined {
  if (!looksLikeInformationalQuestion(userPrompt)) return undefined;
  return [
    'The user is asking an informational question.',
    'Answer in text only.',
    'Do not call document creation, edit, or export tools.',
  ].join(' ');
}
