/// What a turn did to documents, for the line under it: "✓ Done · Updated
/// “Menu” · 3 changes" once it ended, "Still working on “Menu”…" while it runs.
///
/// A model that edits a document in passes often ends a pass on "Now the
/// script:" — and when its turn ended there, nothing said whether it was done.
/// The line says so in past tense, from what the tools did rather than from
/// what the model wrote.

import type { Artifact } from '../ipc/contracts';
import {
  DOCUMENT_CONTENT_TOOL_NAMES,
  isDocumentCreateTool,
  resolveWrittenArtifactId,
} from './agentTools';
import type { AssistantStreamState, ToolCallState } from './streamState';

export interface DocumentOutcome {
  /** The artifact, when it can be found; created documents may lack one while
   *  the artifact list catches up. */
  artifactId?: string;
  title: string;
  /** The turn made the document (rather than only changing one). */
  created: boolean;
  /** Successful content calls on it: writes, edits, patches, sheet edits. */
  changes: number;
}

/** A turn loaded from history is rebuilt from the provider log, which has no
 *  tool results: its calls are complete but carry no status. Count those as
 *  succeeded, as their rows do; a live turn has the status. */
function succeeded(call: ToolCallState): boolean {
  return call.status === 'completed' || (call.status === undefined && call.complete && !call.error);
}

function stringArg(call: ToolCallState, key: string): string | undefined {
  const value = call.arguments?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** The documents a turn created or changed, in the order it first touched
 *  them. Only calls that succeeded count. */
export function turnDocumentOutcomes(
  state: Pick<AssistantStreamState, 'toolCalls'>,
  artifacts: readonly Artifact[],
  messageId?: string,
): DocumentOutcome[] {
  const byKey = new Map<string, DocumentOutcome>();
  for (const call of state.toolCalls) {
    if (!succeeded(call) || !DOCUMENT_CONTENT_TOOL_NAMES.has(call.name)) continue;
    const created = isDocumentCreateTool(call.name);
    const id = resolveWrittenArtifactId(call.name, stringArg(call, 'artifact_id'), artifacts, messageId);
    const artifact = id ? artifacts.find((a) => a.id === id) : undefined;
    const title = artifact?.title?.trim() || stringArg(call, 'title') || '';
    const key = id ?? `title:${title}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.changes += 1;
      existing.created ||= created;
      if (!existing.title && title) existing.title = title;
    } else {
      byKey.set(key, { artifactId: artifact?.id ?? id, title, created, changes: 1 });
    }
  }
  return [...byKey.values()];
}

/** While a turn runs: the title of the document it is working on — the
 *  latest content call, finished or still streaming — if any. */
export function turnDocumentInProgress(
  state: Pick<AssistantStreamState, 'toolCalls'>,
  artifacts: readonly Artifact[],
): string | undefined {
  for (let i = state.toolCalls.length - 1; i >= 0; i -= 1) {
    const call = state.toolCalls[i];
    if (!DOCUMENT_CONTENT_TOOL_NAMES.has(call.name) || call.status === 'failed') continue;
    const id = stringArg(call, 'artifact_id');
    const listed = id ? artifacts.find((a) => a.id === id)?.title?.trim() : undefined;
    return listed || stringArg(call, 'title') || call.documentWrite?.title?.trim() || '';
  }
  return undefined;
}
