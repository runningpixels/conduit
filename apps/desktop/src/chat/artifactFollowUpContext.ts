import type { Artifact } from '../ipc/contracts';
import type { AssistantStreamState } from './streamState';
import { resolveDocumentArtifactId } from './agentTools';
import {
  classifyDocumentTurnIntent,
  looksLikeArtifactEditFollowUp,
  looksLikeInformationalQuestion,
  type DocumentTurnIntent,
} from './documentTurnIntent';
import { looksLikeArtifactCreationRequest } from './artifactPrompt';
import { detectArtifactCandidates } from './artifactCandidates';

/** Document artifact kinds supported for follow-up edit context. */
export const DOCUMENT_ARTIFACT_KINDS = new Set(['html', 'markdown', 'text']);

const EDIT_TOOL_BY_KIND: Record<string, string> = {
  html: 'edit_html_document',
  markdown: 'edit_markdown_document',
  text: 'edit_text_document',
};

const CONTENT_FIELD_BY_KIND: Record<string, string> = {
  html: 'updated_html',
  markdown: 'updated_markdown',
  text: 'updated_text',
};

const FENCE_LANG_BY_KIND: Record<string, string> = {
  html: 'html',
  markdown: 'markdown',
  text: 'text',
};

/** Max artifact body chars injected into the developer prompt (token guard). */
export const ARTIFACT_CONTEXT_CONTENT_CAP = 48_000;

/** A document in scope only because it is open or recent (the turn did not
 *  read as an edit) is pasted only up to this size; a longer one is named and
 *  the model reads it with `read_document` when it needs to. */
export const ARTIFACT_SCOPE_CONTENT_CAP = 16_000;

export interface ChatTurnForContext {
  role: 'user' | 'assistant';
  content: string;
  streamState?: AssistantStreamState;
}

export interface FollowUpArtifactContext {
  artifactId?: string;
  kind: 'html' | 'markdown' | 'text';
  title?: string;
  content: string;
  /** True when content comes from an unpromoted inline fence in chat. */
  inlineOnly?: boolean;
  /** In scope because it is open or recent, not because the turn read as an
   *  edit: a long body is left out (`ARTIFACT_SCOPE_CONTENT_CAP`). */
  fromScope?: boolean;
}

/**
 * True when the user clearly wants a brand-new document rather than editing
 * the one already in scope.
 */
export function looksLikeExplicitNewArtifactRequest(prompt: string): boolean {
  return looksLikeArtifactCreationRequest(prompt);
}

export { looksLikeArtifactEditFollowUp } from './documentTurnIntent';

function isDocumentArtifact(artifact: Artifact): artifact is Artifact & { kind: 'html' | 'markdown' | 'text' } {
  return DOCUMENT_ARTIFACT_KINDS.has(artifact.kind);
}

function isDocumentKind(kind: string): kind is 'html' | 'markdown' | 'text' {
  return DOCUMENT_ARTIFACT_KINDS.has(kind);
}

function contentFromToolArguments(
  streamState: AssistantStreamState,
  kind: string,
): string | undefined {
  const writeTool = kind === 'html' ? 'write_html_document' : kind === 'markdown' ? 'write_markdown_document' : 'write_text_document';
  const editTool = EDIT_TOOL_BY_KIND[kind];
  for (let i = streamState.toolCalls.length - 1; i >= 0; i -= 1) {
    const toolCall = streamState.toolCalls[i];
    if (toolCall.status !== 'completed') continue;
    const args = toolCall.arguments;
    if (!args) continue;
    if (toolCall.name === writeTool && typeof args.html === 'string') return args.html;
    if (toolCall.name === writeTool && typeof args.markdown === 'string') return args.markdown;
    if (toolCall.name === writeTool && typeof args.text === 'string') return args.text;
    const updatedField = CONTENT_FIELD_BY_KIND[kind];
    if (toolCall.name === editTool && typeof args[updatedField] === 'string') {
      return args[updatedField] as string;
    }
  }
  return undefined;
}

/** Latest document-kind fenced block from assistant message text (newest turn first). */
export function resolveInlineDocumentFromHistory(
  history: ChatTurnForContext[],
): FollowUpArtifactContext | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn.role !== 'assistant' || !turn.content.trim()) continue;
    const candidates = detectArtifactCandidates(turn.content);
    for (let j = candidates.length - 1; j >= 0; j -= 1) {
      const candidate = candidates[j];
      if (!isDocumentKind(candidate.kind)) continue;
      return {
        kind: candidate.kind,
        title: candidate.title,
        content: candidate.body,
        inlineOnly: true,
      };
    }
  }
  return undefined;
}

/** Walk assistant turns (newest first) and resolve the latest document artifact id.
 *  When the document panel has an open document, prefer that over history. */
export function resolveRecentDocumentArtifactId(
  history: ChatTurnForContext[],
  listed: Artifact[],
  preferredArtifactId?: string | null,
): string | undefined {
  if (preferredArtifactId) {
    const preferred = listed.find((a) => a.id === preferredArtifactId && isDocumentArtifact(a));
    if (preferred) return preferred.id;
  }

  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn.role !== 'assistant' || !turn.streamState) continue;
    const id = resolveDocumentArtifactId(turn.streamState, listed);
    if (id) return id;
  }

  if (preferredArtifactId) {
    // Panel selection can be ahead of the listed strip; still prefer it so
    // getArtifact can load the open document.
    return preferredArtifactId;
  }

  const doc = listed.find((a) => isDocumentArtifact(a));
  return doc?.id;
}

/** Whether this conversation has a document an edit turn could act on: one
 *  open in the panel, one written in an earlier turn or listed for the chat, or
 *  an inline document in a recent reply. */
export function hasDocumentInScope(
  history: ChatTurnForContext[],
  listed: Artifact[],
  preferredArtifactId?: string | null,
): boolean {
  return (
    resolveRecentDocumentArtifactId(history, listed, preferredArtifactId) != null ||
    resolveInlineDocumentFromHistory(history) != null
  );
}

export function shouldIncludeArtifactFollowUpContext(
  prompt: string,
  history: ChatTurnForContext[],
  artifactId: string | undefined,
): boolean {
  if (looksLikeExplicitNewArtifactRequest(prompt)) return false;
  if (looksLikeInformationalQuestion(prompt)) return false;
  if (!looksLikeArtifactEditFollowUp(prompt)) return false;
  if (artifactId) return true;
  return resolveInlineDocumentFromHistory(history) != null;
}

function truncateContent(content: string): { text: string; truncated: boolean } {
  if (content.length <= ARTIFACT_CONTEXT_CONTENT_CAP) {
    return { text: content, truncated: false };
  }
  return {
    text: `${content.slice(0, ARTIFACT_CONTEXT_CONTENT_CAP)}\n<!-- truncated for context window -->`,
    truncated: true,
  };
}

export function buildArtifactEditDeveloperPrompt(
  context: FollowUpArtifactContext,
  userPrompt: string,
): string {
  const editTool = EDIT_TOOL_BY_KIND[context.kind] ?? 'edit_*_document';
  const contentField = CONTENT_FIELD_BY_KIND[context.kind] ?? 'updated_content';
  const { text, truncated } = truncateContent(context.content);
  const fence = FENCE_LANG_BY_KIND[context.kind] ?? 'text';
  const titleLine = context.title ? `- title: ${context.title}\n` : '';
  const truncatedNote = truncated ? '\n(Content was truncated for the context window; use the artifact as the source of truth.)' : '';

  if (context.inlineOnly || !context.artifactId) {
    return [
      'A document from the recent assistant reply is in scope for this conversation (inline in chat, not yet promoted to an artifact).',
      `${titleLine}- kind: ${context.kind}`,
      `The user follow-up: "${userPrompt.trim()}"`,
      'If they asked to revise it, output the full updated body in a labeled fenced code block in your reply.',
      'Do NOT call write_*_document or edit_*_document unless the user explicitly asked to create or persist a new document artifact.',
      'If they only asked a question or made a general comment, answer in text and do NOT emit a revised fence.',
      `Current content:${truncatedNote}`,
      `\`\`\`${fence}`,
      text,
      '```',
    ].join('\n');
  }

  // In scope without edit wording (a question, another language): a long
  // document is named, not pasted, so a "thanks!" does not resend it in full.
  const contentOmitted = context.fromScope === true && context.content.length > ARTIFACT_SCOPE_CONTENT_CAP;
  const quoteFrom = contentOmitted ? 'the read_document result' : 'the content below';
  return [
    'An existing document artifact is in scope for this conversation.',
    `${titleLine}- artifact_id: ${context.artifactId}`,
    `- kind: ${context.kind}`,
    `The user follow-up: "${userPrompt.trim()}"`,
    ...(context.fromScope
      ? ['The follow-up may be about this document even if it does not name it, in any language.']
      : []),
    'This document is stored in the app, not as a file in a workspace folder: change it with the document tools and its artifact_id, and do not search files for it.',
    'Only call a document tool if the user explicitly asked to create or revise this document.',
    ...(contentOmitted
      ? [`Its content is not included here: call read_document with artifact_id "${context.artifactId}" before changing it.`]
      : []),
    `If they asked to change part of it, use patch_document with artifact_id "${context.artifactId}", quoting the exact text to replace from ${quoteFrom}.`,
    `If most of it changes, use ${editTool} with artifact_id "${context.artifactId}" and the full updated body in ${contentField}.`,
    'If they only asked a question or made a general comment, answer in text and do NOT call document tools.',
    'Do NOT call write_*_document without artifact_id unless the user explicitly asked for a separate or new document.',
    ...(contentOmitted ? [] : [`Current content:${truncatedNote}`, `\`\`\`${fence}`, text, '```']),
  ].join('\n');
}

export type GetArtifactFn = (artifactId: string) => Promise<Artifact | null>;

/**
 * Resolve follow-up artifact context for the next provider request.
 * Returns undefined when no artifact should be injected.
 *
 * `preferredArtifact` is the document currently open in the panel — when the
 * user asks to revise "the document", that is the one in scope.
 */
export async function resolveFollowUpArtifactContext(
  history: ChatTurnForContext[],
  prompt: string,
  listed: Artifact[],
  getArtifact: GetArtifactFn,
  preferredArtifact?: Artifact | null,
  /** The prompt is known to revise the document in scope (an app-authored
   *  follow-up such as "Continue building"), whatever its wording. */
  options: {
    forceEdit?: boolean;
    /** The document is in scope because it is open or recent, not because of
     *  the prompt's wording (`resolveTurnDocumentScope`). Implies `forceEdit`. */
    fromScope?: boolean;
  } = {},
): Promise<FollowUpArtifactContext | undefined> {
  const preferredId =
    preferredArtifact && isDocumentArtifact(preferredArtifact)
      ? preferredArtifact.id
      : undefined;
  const artifactId = resolveRecentDocumentArtifactId(history, listed, preferredId);
  const include = options.forceEdit || options.fromScope
    ? Boolean(artifactId)
    : shouldIncludeArtifactFollowUpContext(prompt, history, artifactId);
  if (!include) {
    return undefined;
  }

  const listedRow = artifactId ? listed.find((a) => a.id === artifactId) : undefined;
  const preferredRow =
    preferredArtifact && preferredArtifact.id === artifactId && isDocumentArtifact(preferredArtifact)
      ? preferredArtifact
      : undefined;
  const kind =
    (preferredRow && isDocumentArtifact(preferredRow) ? preferredRow.kind : undefined) ??
    (listedRow && isDocumentArtifact(listedRow) ? listedRow.kind : undefined);

  let resolvedKind: 'html' | 'markdown' | 'text' | undefined = kind;
  let title = preferredRow?.title ?? listedRow?.title;
  let content: string | undefined;

  if (artifactId) {
    const full = await getArtifact(artifactId);
    if (full) {
      if (!resolvedKind && isDocumentArtifact(full)) resolvedKind = full.kind;
      title = full.title ?? title;
      if (typeof full.contentText === 'string' && full.contentText.length > 0) {
        content = full.contentText;
      }
    }
  }

  if (!content && preferredRow && typeof preferredRow.contentText === 'string' && preferredRow.contentText.length > 0) {
    content = preferredRow.contentText;
    if (!resolvedKind) resolvedKind = preferredRow.kind;
  }

  if (!content) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const turn = history[i];
      if (turn.role !== 'assistant' || !turn.streamState) continue;
      const fromTools = resolvedKind ? contentFromToolArguments(turn.streamState, resolvedKind) : undefined;
      if (fromTools) {
        content = fromTools;
        break;
      }
      for (const k of ['html', 'markdown', 'text'] as const) {
        const extracted = contentFromToolArguments(turn.streamState, k);
        if (extracted) {
          content = extracted;
          resolvedKind = resolvedKind ?? k;
          break;
        }
      }
      if (content) break;
    }
  }

  if (!content) {
    const inline = resolveInlineDocumentFromHistory(history);
    if (inline) {
      return inline;
    }
  }

  if (!resolvedKind || !content) return undefined;

  const result: FollowUpArtifactContext = {
    artifactId,
    kind: resolvedKind,
    title,
    content,
  };
  if (!artifactId) {
    result.inlineOnly = true;
  }
  if (options.fromScope) {
    result.fromScope = true;
  }
  return result;
}

/** How a chat turn relates to the documents in scope for it. */
export interface TurnDocumentScope {
  /** Intent for tool selection; `undefined` lets the selection classify the prompt. */
  toolIntent: DocumentTurnIntent | undefined;
  /** Resolve the follow-up context of the document in scope whatever the wording. */
  forceEdit: boolean;
  /** The document is in scope by being open or recent, not by edit wording. */
  fromScope: boolean;
}

/**
 * Decide a normal chat turn's document routing (deck and draft chats have
 * their own).
 *
 * The intent regexes read English only, and a request worded as a question
 * ("nice, can you make a nice chart in it?") classified as informational:
 * no edit tools, no document named anywhere, so the model looked for the
 * dashboard in the user's files and then wrote a new one. So when a document
 * artifact is in scope — open in the panel, or the latest one in this chat —
 * every turn that is not a request for a new document gets the edit tools and
 * the document's id. Questions about it are still answered in text (the edit
 * prompt says so). A turn with no document in scope is classified as before.
 */
export function resolveTurnDocumentScope(
  prompt: string,
  history: ChatTurnForContext[],
  listed: Artifact[],
  preferredArtifact: Artifact | null | undefined,
  /** Intent an app-authored prompt or a picked chip already fixed. */
  explicitIntent?: DocumentTurnIntent,
): TurnDocumentScope {
  if (explicitIntent !== undefined) {
    return { toolIntent: explicitIntent, forceEdit: explicitIntent === 'edit', fromScope: false };
  }
  const classified = classifyDocumentTurnIntent(prompt);
  if (classified === 'create') return { toolIntent: undefined, forceEdit: false, fromScope: false };
  const preferredId =
    preferredArtifact && isDocumentArtifact(preferredArtifact) ? preferredArtifact.id : undefined;
  if (resolveRecentDocumentArtifactId(history, listed, preferredId) != null) {
    return { toolIntent: 'edit', forceEdit: classified === 'edit', fromScope: classified !== 'edit' };
  }
  // An edit-sounding prompt with nothing to edit ("…and add a summary" in a
  // fresh chat) would get edit tools only, which need an existing artifact_id.
  if (classified === 'edit' && !hasDocumentInScope(history, listed, preferredId)) {
    return { toolIntent: 'general', forceEdit: false, fromScope: false };
  }
  return { toolIntent: undefined, forceEdit: false, fromScope: false };
}
