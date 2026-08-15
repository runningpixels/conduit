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