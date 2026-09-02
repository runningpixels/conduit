import { beforeEach, describe, expect, it, vi } from 'vitest';

/// Mock the Tauri core IPC. `vi.hoisted` runs before the auto-hoisted
/// `vi.mock` factory, so the mock fn is initialized in time for the factory.
const { invoke, Channel } = vi.hoisted(() => {
  class Channel<T> {
    onmessage: ((msg: T) => void) | null = null;
  }
  return { invoke: vi.fn(), Channel };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel }));

import {
  createArtifact,
  listArtifacts,
  getMessageIdByRequest,
  getArtifact,
  setArtifactContent,
  getArtifactContentBytes,
  checkArtifactFileState,
  exportArtifact,
  previewConversationExport,
  exportConversationDialog,
  prepareMessageEdit,
  setConversationChatSettings,
  openExternalUrl,
  saveAttachment,
  listAttachments,
  deleteAttachment,
  getAttachmentBytes,
} from './client';

beforeEach(() => {
  invoke.mockReset();
});

describe('artifact + attachment IPC wrappers', () => {
  it('setConversationPinned calls set_conversation_pinned', async () => {
    invoke.mockResolvedValue(undefined);
    const { setConversationPinned } = await import('./client');
    await setConversationPinned('c1', true);
    expect(invoke).toHaveBeenCalledWith('set_conversation_pinned', {
      conversationId: 'c1',
      pinned: true,
    });
  });
  it('createArtifact calls create_artifact with camelCase args', async () => {
    invoke.mockResolvedValue({ id: 'a1' });
    await createArtifact('c1', 'markdown', 'Note', 'm1');
    expect(invoke).toHaveBeenCalledWith('create_artifact', {
      conversationId: 'c1',
      kind: 'markdown',
      title: 'Note',
      sourceMessageId: 'm1',
    });
  });

  it('listArtifacts calls list_artifacts with conversationId', async () => {
    invoke.mockResolvedValue([]);
    await listArtifacts('c1');
    expect(invoke).toHaveBeenCalledWith('list_artifacts', { conversationId: 'c1' });
  });

  it('getMessageIdByRequest calls get_message_id_by_request with requestId', async () => {
    invoke.mockResolvedValue('msg-uuid');
    const got = await getMessageIdByRequest('req-1');
    expect(invoke).toHaveBeenCalledWith('get_message_id_by_request', { requestId: 'req-1' });
    expect(got).toBe('msg-uuid');
  });

  it('getArtifact calls get_artifact with artifactId, returns nullable', async () => {
    invoke.mockResolvedValue(null);
    const got = await getArtifact('a1');
    expect(invoke).toHaveBeenCalledWith('get_artifact', { artifactId: 'a1' });
    expect(got).toBeNull();
  });

  it('setArtifactContent calls set_artifact_content with artifactId, mimeType, content', async () => {
    invoke.mockResolvedValue({ id: 'a1' });
    const content = { kind: 'text' as const, text: 'hi' };
    await setArtifactContent('a1', content, 'text/markdown');
    expect(invoke).toHaveBeenCalledWith('set_artifact_content', {
      artifactId: 'a1',
      mimeType: 'text/markdown',
      content,
    });
  });

  it('getArtifactContentBytes returns number[]', async () => {
    invoke.mockResolvedValue([104, 105]);
    const bytes = await getArtifactContentBytes('a1');
    expect(invoke).toHaveBeenCalledWith('get_artifact_content_bytes', { artifactId: 'a1' });
    expect(bytes).toEqual([104, 105]);
  });

  it('checkArtifactFileState calls check_artifact_file_state', async () => {
    invoke.mockResolvedValue('ok');
    const state = await checkArtifactFileState('a1');
    expect(invoke).toHaveBeenCalledWith('check_artifact_file_state', { artifactId: 'a1' });
    expect(state).toBe('ok');
  });

  it('exportArtifact calls export_artifact with includeMetadata', async () => {
    invoke.mockResolvedValue({ exportedTo: '/o.md', bytesWritten: 10 });
    const res = await exportArtifact('a1', true);
    expect(invoke).toHaveBeenCalledWith('export_artifact', { artifactId: 'a1', includeMetadata: true });
    expect(res).toEqual({ exportedTo: '/o.md', bytesWritten: 10 });
  });

  it('previewConversationExport calls preview_conversation_export with camelCase args', async () => {
    invoke.mockResolvedValue('# Chat\n');
    const md = await previewConversationExport('c1', 'markdown');
    expect(invoke).toHaveBeenCalledWith('preview_conversation_export', {
      conversationId: 'c1',
      format: 'markdown',
    });
    expect(md).toBe('# Chat\n');
  });

  it('exportConversationDialog calls export_conversation_dialog with camelCase args', async () => {
    invoke.mockResolvedValue({ exportedTo: '/o.json', bytesWritten: 42 });
    const res = await exportConversationDialog('c1', 'json', true);
    expect(invoke).toHaveBeenCalledWith('export_conversation_dialog', {
      conversationId: 'c1',
      format: 'json',
      includeAttachments: true,
    });
    expect(res).toEqual({ exportedTo: '/o.json', bytesWritten: 42 });
  });

  it('exportConversationDialog defaults includeAttachments to false', async () => {
    invoke.mockResolvedValue(null);
    const res = await exportConversationDialog('c1', 'markdown');
    expect(invoke).toHaveBeenCalledWith('export_conversation_dialog', {
      conversationId: 'c1',
      format: 'markdown',
      includeAttachments: false,
    });
    expect(res).toBeNull();
  });

  it('prepareMessageEdit calls prepare_message_edit with camelCase args', async () => {
    invoke.mockResolvedValue({
      conversation: { id: 'c1', createdAt: 't', updatedAt: 't' },
      mode: 'in_place',
    });
    const res = await prepareMessageEdit('c1', 'm1');
    expect(invoke).toHaveBeenCalledWith('prepare_message_edit', {
      conversationId: 'c1',
      messageId: 'm1',
    });
    expect(res.mode).toBe('in_place');
  });

  it('setConversationChatSettings calls set_conversation_chat_settings', async () => {
    invoke.mockResolvedValue({ id: 'c1', createdAt: 't', updatedAt: 't' });
    await setConversationChatSettings('c1', { temperature: 0.2 }, 'Be brief.');
    expect(invoke).toHaveBeenCalledWith('set_conversation_chat_settings', {
      conversationId: 'c1',
      generationControls: { temperature: 0.2 },
      userInstructions: 'Be brief.',
    });
  });

  it('openExternalUrl calls open_external_url with the url', async () => {
    invoke.mockResolvedValue(undefined);
    await openExternalUrl('https://example.com/a');
    expect(invoke).toHaveBeenCalledWith('open_external_url', { url: 'https://example.com/a' });
  });

  it('saveAttachment / listAttachments / deleteAttachment / getAttachmentBytes', async () => {
    invoke.mockResolvedValue({ id: 'att1' });
    await saveAttachment('c1', [1, 2], 'image/png', 'drop');
    expect(invoke).toHaveBeenCalledWith('save_attachment', {
      conversationId: 'c1',
      bytes: [1, 2],
      mimeType: 'image/png',
      origin: 'drop',
    });

    invoke.mockResolvedValue([]);
    await listAttachments('c1');
    expect(invoke).toHaveBeenLastCalledWith('list_attachments', { conversationId: 'c1' });

    invoke.mockResolvedValue(undefined);
    await deleteAttachment('att1');
    expect(invoke).toHaveBeenLastCalledWith('delete_attachment', { attachmentId: 'att1' });

    invoke.mockResolvedValue([9, 9]);
    await getAttachmentBytes('att1');
    expect(invoke).toHaveBeenLastCalledWith('get_attachment_bytes', { attachmentId: 'att1' });
  });
});