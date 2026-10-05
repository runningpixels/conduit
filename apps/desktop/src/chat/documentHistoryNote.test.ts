import { describe, expect, it } from 'vitest';
import { documentWritesHistoryNote, webToolsHistoryNote } from './agentTools';
import { historyContentForTurn } from './ChatView';
import { applyProviderEvent, createAssistantStreamState, type AssistantStreamState } from './streamState';
import type { ChatTurn } from './conversationHydration';

function writeTurn(name: string, args: Record<string, unknown>, status?: 'failed'): AssistantStreamState {
  let state = createAssistantStreamState('req-1');
  state = applyProviderEvent(state, {
    kind: 'toolCallStart',
    requestId: 'req-1',
    toolCallId: 'tc-1',
    index: 0,
    toolId: name,
    name,
  });
  state = applyProviderEvent(state, {
    kind: 'toolCallComplete',
    requestId: 'req-1',
    toolCallId: 'tc-1',
    index: 1,
    arguments: args,
  });
  if (status) {
    state = applyProviderEvent(state, {
      kind: 'toolExecutionFinished',
      requestId: 'req-1',
      toolCallId: 'tc-1',
      toolName: name,
      isError: true,
      error: 'missing field html',
    });
  }
  return { ...state, streaming: false };
}

describe('documentWritesHistoryNote', () => {
  it('names each document the turn wrote', () => {
    expect(
      documentWritesHistoryNote(writeTurn('write_html_document', { title: 'Solar System Field Guide', html: '<p>' })),
    ).toBe('[Wrote HTML document "Solar System Field Guide" with write_html_document.]');
    expect(documentWritesHistoryNote(writeTurn('edit_markdown_document', { artifact_id: 'a1', updated_markdown: '#' }))).toBe(
      '[Updated Markdown document with edit_markdown_document.]',
    );
    expect(
      documentWritesHistoryNote(
        writeTurn('patch_document', { artifact_id: 'a1', edits: [{ old_text: 'a', new_text: 'b' }] }),
      ),
    ).toBe('[Patched a document with patch_document (1 edit).]');
    expect(documentWritesHistoryNote(writeTurn('read_document', { artifact_id: 'a1' }))).toBe('');
  });

  it('leaves out failed writes and turns without any', () => {
    expect(documentWritesHistoryNote(writeTurn('write_html_document', { title: 'Broken' }, 'failed'))).toBe('');
    expect(documentWritesHistoryNote(writeTurn('current_time', {}))).toBe('');
    expect(documentWritesHistoryNote(undefined)).toBe('');
  });
});

describe('webToolsHistoryNote', () => {
  it('says a turn searched or fetched the web, and stays empty otherwise', () => {
    expect(webToolsHistoryNote(writeTurn('web_search', { query: 'tauri release' }))).toBe(
      '[This reply searched the web 1 time; its findings and links came from those real results.]',
    );
    expect(webToolsHistoryNote(writeTurn('web_fetch', { url: 'https://example.com' }))).toContain(
      'read 1 page with web_fetch',
    );
    expect(webToolsHistoryNote(writeTurn('web_search', { query: 'x' }, 'failed'))).toBe('');
    expect(webToolsHistoryNote(writeTurn('current_time', {}))).toBe('');
    expect(webToolsHistoryNote(undefined)).toBe('');
  });
});

describe('historyContentForTurn', () => {
  it('leads a searched turn with a note, so a later turn does not call its findings invented', () => {
    const turn: ChatTurn = {
      id: 'm-3',
      role: 'assistant',
      content: 'tauri 2.12.1 is the latest release [1].',
      streamState: writeTurn('web_search', { query: 'tauri latest release' }),
    };
    expect(historyContentForTurn(turn)).toBe(
      '[This reply searched the web 1 time; its findings and links came from those real results.]\n\ntauri 2.12.1 is the latest release [1].',
    );
    expect(historyContentForTurn({ ...turn, role: 'user' })).toBe(turn.content);
  });

  it('keeps a document-only assistant turn in history as a note', () => {
    const turn: ChatTurn = {
      id: 'm-2',
      role: 'assistant',
      content: '',
      streamState: writeTurn('write_html_document', { title: 'Guide', html: '<p>' }),
    };
    expect(historyContentForTurn(turn)).toContain('Wrote HTML document "Guide"');
  });

  it('leaves turns with text, and user turns, as they are', () => {
    expect(historyContentForTurn({ id: 'm-1', role: 'user', content: 'make a guide' })).toBe('make a guide');
    expect(
      historyContentForTurn({
        id: 'm-3',
        role: 'assistant',
        content: 'Here is your guide.',
        streamState: writeTurn('write_html_document', { title: 'Guide', html: '<p>' }),
      }),
    ).toBe('Here is your guide.');
  });
});
