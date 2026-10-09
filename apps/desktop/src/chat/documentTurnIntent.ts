import { looksLikeArtifactCreationRequest } from './artifactPrompt';

/** How the current user turn relates to document artifact tools. */
export type DocumentTurnIntent = 'info' | 'create' | 'edit' | 'general';

/* Imperative revisions too: "Two fixes: clear the error banner…, put the
 * cards in one row" matched none of the verbs before and, being a general
 * turn, got no edit tools, so the model pasted a whole new page and the
 * original's site permissions stayed behind on the old one. Code verbs
 * (rename, move, replace) stay out: "rename the helper in utils" is a
 * workspace edit, not a document one. */
const EDIT_FOLLOW_UP_REGEX =
  /\b(edit|update|change|modify|revise|rewrite|adjust|improve|fix(es|ed)?|tweak|dark\s*mode|light\s*mode|add|remove|make\s+it|turn\s+it|convert|clear|put|shorten|tighten|enlarge|shrink|increase|decrease|reduce|hide|align|cent(er|re)|resize|recolou?r|give\s+(it|the))\b/i;

/* Additions to an existing document that the verbs above miss: "include
 * detailed rainfall", "insert a table", and making something *in* it — "can
 * you make a nice chart in it?" read as a question and got no edit tools.
 * `include` etc. need a following word, and a question about something
 * ("does the price include tax?") is not read as one. A secondary signal
 * only: with a document in scope every turn gets the edit tools anyway
 * (`resolveTurnDocumentScope`). */
const ASKS_ABOUT_PREFIX_REGEX =
  /^(what|which|why|when|where|who|how|does|do|did|is|are|was|were|will|would|should|tell me)\b/i;
const EDIT_ADDITION_REGEX =
  /\b(include|insert|append|embed)\s+(?!(and|or|but|so|in|on|at|for)\b)\w|\b(make|create|draw|build|plot|show|add|put)\b.*\b(in|into|inside|to)\s+(it|this|that)\b|\b(make|create|draw|build|plot|add)\b.*\b(charts?|graphs?|tables?|sections?)\b.*\b(in|into|inside|to)\s+(it|this|that|the\s+\w+)\b/i;

const INFORMATIONAL_PREFIX_REGEX =
  /^(what|which|how|why|when|where|who|can you|could you|do you|does|are|is|tell me about)\b/i;

/** Document capability questions that mention edit/create but are not edit requests. */
function looksLikeDocumentCapabilityQuestion(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed.endsWith('?')) return false;
  if (!/^(can you|could you|do you|what|which|how)\b/i.test(trimmed)) return false;
  // Concrete revision asks ("can you add urls to the document?") are edit
  // follow-ups. Capability questions talk about formats/abilities without an
  // action verb that mutates content — e.g. "can you edit markdown?".
  if (
    /\b(add|remove|update|change|modify|revise|rewrite|adjust|improve|fix|tweak|make\s+it|turn\s+it|convert|include|insert|append)\b/i.test(
      trimmed,
    )
  ) {
    return false;
  }
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
  return (
    EDIT_FOLLOW_UP_REGEX.test(trimmed) ||
    (!ASKS_ABOUT_PREFIX_REGEX.test(trimmed) && EDIT_ADDITION_REGEX.test(trimmed))
  );
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

/**
 * Guidance for turns where document write/edit tools are offered.
 *
 * Reasoning models were drafting the whole document — structure, copy, CSS —
 * in their reasoning and then generating it again as the tool call, which
 * doubled the time to a document (107s of reasoning, then 85s of tool call, in
 * one measured run). Worded conditionally: this is guidance on *how* to write
 * a document if one is written, not pressure to write one (see the comment on
 * `isCreationIntent` in `buildProviderRequest`).
 */
export function documentWriteDeveloperPromptFor(
  toolNames: readonly string[],
  options: {
    /** The active model was seen sending documents in one burst rather than
     *  streaming them (`streamingBehavior.ts`). */
    heldDocuments?: boolean;
  } = {},
): string | undefined {
  const offersDocumentWrites = toolNames.some((name) => /^(write|edit)_(html|markdown|text)_document$/.test(name));
  if (!offersDocumentWrites) return undefined;
  const lines = [
    'If you create or revise a document with a write_*_document or edit_*_document tool:',
    'plan its structure in a few short lines at most, and do not draft the document, its copy or its styles in your reasoning.',
    'Write the content once, directly in the tool call, and pass title before the content.',
  ];
  // Building a document in parts is not suggested to every model: each part is
  // a round of its own, and live it turned a one-call document into a
  // multi-minute build even with room to spare. The agent loop asks for parts
  // after a write is actually cut off at the output limit.
  //
  // The exception is a model that sends a document in one burst. Nothing
  // arrives while it writes, and a long document meant two minutes of silence
  // that OpenRouter ended with "Upstream idle timeout exceeded", twice in a
  // row. Parts keep each silence short.
  if (toolNames.includes('patch_document')) {
    if (options.heldDocuments) {
      lines.push(
        'For a long document — more than about 200 lines — write it in parts:',
        'first the full structure with a placeholder comment such as <!-- section: moons --> where each long section goes, with more_to_write: true;',
        'then replace the placeholders with patch_document, one or two sections per call, with more_to_write: true on every call but the last.',
      );
    }
    lines.push('To change part of an existing document, use patch_document rather than rewriting it.');
  }
  return lines.join(' ');
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
