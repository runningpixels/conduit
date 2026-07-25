import type { Artifact } from '../ipc/contracts';
import type { AssistantStreamState } from './streamState';
import { resolveDocumentArtifactId } from './agentTools';
import {
  looksLikeArtifactEditFollowUp,
  looksLikeInformationalQuestion,
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

/** Walk assistant turns (newest first) and resolve the latest document artifact id. */
export function resolveRecentDocumentArtifactId(
  history: ChatTurnForContext[],
  listed: Artifact[],
): string | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn.role !== 'assistant' || !turn.streamState) continue;
    const id = resolveDocumentArtifactId(turn.streamState, listed);
    if (id) return id;
  }

  const doc = listed.find((a) => isDocumentArtifact(a));
  return doc?.id;
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

  return [
    'An existing document artifact is in scope for this conversation.',
    `${titleLine}- artifact_id: ${context.artifactId}`,
    `- kind: ${context.kind}`,
    `The user follow-up: "${userPrompt.trim()}"`,
    'Only call a document tool if the user explicitly asked to create or revise this document.',
    `If they asked to revise it, use ${editTool} with artifact_id "${context.artifactId}" and the full updated body in ${contentField}.`,
    'If they only asked a question or made a general comment, answer in text and do NOT call document tools.',
    'Do NOT call write_*_document without artifact_id unless the user explicitly asked for a separate or new document.',
    `Current content:${truncatedNote}`,
    `\`\`\`${fence}`,
    text,
    '```',
  ].join('\n');
}

export type GetArtifactFn = (artifactId: string) => Promise<Artifact | null>;

/**
 * Resolve follow-up artifact context for the next provider request.
 * Returns undefined when no artifact should be injected.
 */
export async function resolveFollowUpArtifactContext(
  history: ChatTurnForContext[],
  prompt: string,
  listed: Artifact[],
  getArtifact: GetArtifactFn,
): Promise<FollowUpArtifactContext | undefined> {
  const artifactId = resolveRecentDocumentArtifactId(history, listed);
  if (!shouldIncludeArtifactFollowUpContext(prompt, history, artifactId)) {
    return undefined;
  }

  const listedRow = artifactId ? listed.find((a) => a.id === artifactId) : undefined;
  const kind = listedRow && isDocumentArtifact(listedRow) ? listedRow.kind : undefined;

  let resolvedKind: 'html' | 'markdown' | 'text' | undefined = kind;
  let title = listedRow?.title;
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
  return result;
}
