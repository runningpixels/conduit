import { describe, expect, it } from 'vitest';
import type { Artifact } from '../ipc/contracts';
import type { ToolCallState } from './streamState';
import { turnDocumentInProgress, turnDocumentOutcomes } from './turnDocumentOutcome';

function artifact(over: Partial<Artifact> & { id: string }): Artifact {
  return { conversationId: 'c1', kind: 'html', title: 'Untitled', createdAt: '2026-01-01T00:00:00Z', ...over } as Artifact;
}

let n = 0;
function call(name: string, args: Record<string, unknown> | undefined, over: Partial<ToolCallState> = {}): ToolCallState {
  n += 1;
  return {
    toolCallId: `tc-${n}`,
    toolId: name,
    name,
    argumentsText: args ? JSON.stringify(args) : '',
    arguments: args,
    complete: args !== undefined,
    status: 'completed',
    ...over,
  };
}

const menu = artifact({ id: 'a-menu', title: 'Cafe Menu Pricing Calculator', sourceMessageId: 'm-1' });
const brief = artifact({ id: 'a-brief', kind: 'markdown', title: 'Project Brief' });

describe('turnDocumentOutcomes', () => {
  it('counts the changes per document and names it from the artifact list', () => {
    const outcomes = turnDocumentOutcomes(
      {
        toolCalls: [
          call('read_document', { artifact_id: 'a-menu' }),
          call('patch_document', { artifact_id: 'a-menu', edits: [] }),
          call('patch_document', { artifact_id: 'a-menu', edits: [] }),
          call('edit_markdown_document', { artifact_id: 'a-brief', updated_markdown: '# x' }),
          call('patch_document', { artifact_id: 'a-menu', edits: [] }, { status: 'failed' }),
        ],
      },
      [menu, brief],
    );
    expect(outcomes).toEqual([
      { artifactId: 'a-menu', title: 'Cafe Menu Pricing Calculator', created: false, changes: 2 },
      { artifactId: 'a-brief', title: 'Project Brief', created: false, changes: 1 },
    ]);
  });

  it('finds a created document by the turn that wrote it, even under a model-made id', () => {
    const outcomes = turnDocumentOutcomes(
      { toolCalls: [call('write_html_document', { artifact_id: 'menu.html', title: 'Menu', html: '<p>' })] },
      [brief, menu],
      'm-1',
    );
    expect(outcomes).toEqual([
      { artifactId: 'a-menu', title: 'Cafe Menu Pricing Calculator', created: true, changes: 1 },
    ]);
  });

  it('counts the calls of a turn loaded from history, which carry no status', () => {
    const outcomes = turnDocumentOutcomes(
      {
        toolCalls: [
          call('patch_document', { artifact_id: 'a-menu', edits: [] }, { status: undefined }),
          call('patch_document', { artifact_id: 'a-menu', edits: [] }, { status: undefined, complete: false }),
        ],
      },
      [menu],
    );
    expect(outcomes).toEqual([
      { artifactId: 'a-menu', title: 'Cafe Menu Pricing Calculator', created: false, changes: 1 },
    ]);
  });

  it('is empty for a turn that only read or searched', () => {
    expect(
      turnDocumentOutcomes({ toolCalls: [call('read_document', { artifact_id: 'a-menu' }), call('web_search', { q: 'x' })] }, [menu]),
    ).toEqual([]);
  });
});

describe('turnDocumentInProgress', () => {
  it('names the latest document the running turn touched', () => {
    const state = {
      toolCalls: [
        call('patch_document', { artifact_id: 'a-brief', edits: [] }),
        call('patch_document', { artifact_id: 'a-menu', edits: [] }),
      ],
    };
    expect(turnDocumentInProgress(state, [menu, brief])).toBe('Cafe Menu Pricing Calculator');
  });

  it('uses the streamed title of a write whose arguments are still arriving', () => {
    const streaming = call('write_html_document', undefined, {
      status: undefined,
      documentWrite: { contentField: 'html', title: 'Bakery Dashboard', contentChars: 10, contentLines: 1 } as ToolCallState['documentWrite'],
    });
    expect(turnDocumentInProgress({ toolCalls: [streaming] }, [])).toBe('Bakery Dashboard');
  });

  it('decodes a title the model wrote HTML-escaped, as the saved document will have it', () => {
    const streaming = call('write_html_document', undefined, {
      status: undefined,
      documentWrite: { contentField: 'html', title: 'Maple &amp; Rye &#8212; Menu', contentChars: 10, contentLines: 1 } as ToolCallState['documentWrite'],
    });
    expect(turnDocumentInProgress({ toolCalls: [streaming] }, [])).toBe('Maple & Rye — Menu');
  });

  it('is undefined before any document tool ran, and empty when no title is known yet', () => {
    expect(turnDocumentInProgress({ toolCalls: [call('web_search', { q: 'x' })] }, [])).toBeUndefined();
    expect(turnDocumentInProgress({ toolCalls: [call('patch_document', { artifact_id: 'gone' })] }, [])).toBe('');
  });
});
