/**
 * The pending artifact is the document panel's "generating…" state, and the end
 * of a turn is the only thing that ever resolves it. A turn that died mid-write
 * used to leave it set, so the panel shimmered forever over a document that was
 * never coming.
 */

import { describe, expect, it } from 'vitest';
import { resolveFailedPendingArtifact, type PendingArtifact } from './pendingArtifact';
import { createAssistantStreamState, type AssistantStreamState } from '../chat/streamState';

const pending: PendingArtifact = {
  kind: 'html',
  title: 'Today’s News',
  toolName: 'write_html_document',
  mode: 'create',
  status: 'generating',
};

function ended(over: Partial<AssistantStreamState> = {}): AssistantStreamState {
  return { ...createAssistantStreamState('req-1'), streaming: false, ...over };
}

describe('resolveFailedPendingArtifact', () => {
  it('explains a turn that died before the tool reported', () => {
    const next = resolveFailedPendingArtifact(
      pending,
      ended({ error: 'Agent turn exceeded wall-clock budget (300s).' }),
    );

    expect(next).toMatchObject({
      status: 'failed',
      error: 'Agent turn exceeded wall-clock budget (300s).',
      title: 'Today’s News',
    });
  });

  it('prefers the document tool’s own error over the turn error', () => {
    const next = resolveFailedPendingArtifact(
      pending,
      ended({
        error: 'Stream failed',
        toolCalls: [
          {
            toolCallId: 'c1',
            toolId: 'write_html_document',
            name: 'write_html_document',
            argumentsText: '',
            complete: true,
            status: 'failed',
            error: 'Artifact path is outside the workspace.',
          },
        ],
      }),
    );

    expect(next?.error).toBe('Artifact path is outside the workspace.');
  });

  it('drops the panel when nothing failed and the model just wrote no document', () => {
    expect(resolveFailedPendingArtifact(pending, ended())).toBeNull();
  });

  it('ignores a failure on a non-document tool', () => {
    const next = resolveFailedPendingArtifact(
      pending,
      ended({
        toolCalls: [
          {
            toolCallId: 'c1',
            toolId: 'current_time',
            name: 'current_time',
            argumentsText: '',
            complete: true,
            status: 'failed',
            error: 'clock unavailable',
          },
        ],
      }),
    );

    expect(next).toBeNull();
  });

  it('stays null when there was no pending artifact to begin with', () => {
    expect(resolveFailedPendingArtifact(null, ended({ error: 'boom' }))).toBeNull();
  });
});
