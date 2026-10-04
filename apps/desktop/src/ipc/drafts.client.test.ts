import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invoke, Channel } = vi.hoisted(() => {
  class Channel<T> {
    onmessage: ((msg: T) => void) | null = null;
  }
  return { invoke: vi.fn(), Channel };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel }));

import {
  createDraft,
  deleteDraft,
  draftForConversation,
  exportDraft,
  getDraft,
  getDraftResearchMaterial,
  listDrafts,
  listResearchReports,
  listDraftSnapshots,
  renameDraft,
  restoreDraftSnapshot,
  saveDraftMarkdown,
  setBlockPinned,
  setDraftOutline,
  setDraftSources,
  setDraftStage,
  snapshotDraft,
} from './client';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
});

describe('Writing IPC wrappers', () => {
  it('send the contract command names with camelCase args', async () => {
    await listDrafts();
    expect(invoke).toHaveBeenLastCalledWith('list_drafts');
    await createDraft('A post');
    expect(invoke).toHaveBeenLastCalledWith('create_draft', { brief: 'A post' });
    await getDraft('d1');
    expect(invoke).toHaveBeenLastCalledWith('get_draft', { draftId: 'd1' });
    await renameDraft('d1', 'New');
    expect(invoke).toHaveBeenLastCalledWith('rename_draft', { draftId: 'd1', title: 'New' });
    await deleteDraft('d1');
    expect(invoke).toHaveBeenLastCalledWith('delete_draft', { draftId: 'd1' });
    await saveDraftMarkdown('d1', '# Hi');
    expect(invoke).toHaveBeenLastCalledWith('save_draft_markdown', { draftId: 'd1', markdown: '# Hi' });
    const outline = [{ heading: 'Why', intent: 'x', targetWords: 100 }];
    await setDraftOutline('d1', outline);
    expect(invoke).toHaveBeenLastCalledWith('set_draft_outline', { draftId: 'd1', outline });
    await setDraftStage('d1', 'draft');
    expect(invoke).toHaveBeenLastCalledWith('set_draft_stage', { draftId: 'd1', stage: 'draft' });
    await setBlockPinned('d1', 'b2', false);
    expect(invoke).toHaveBeenLastCalledWith('set_block_pinned', { draftId: 'd1', blockId: 'b2', pinned: false });
    await listDraftSnapshots('d1');
    expect(invoke).toHaveBeenLastCalledWith('list_draft_snapshots', { draftId: 'd1' });
    await snapshotDraft('d1', 'ai-turn', 'Shorter');
    expect(invoke).toHaveBeenLastCalledWith('snapshot_draft', { draftId: 'd1', cause: 'ai-turn', label: 'Shorter' });
    await restoreDraftSnapshot('d1', 's1');
    expect(invoke).toHaveBeenLastCalledWith('restore_draft_snapshot', { draftId: 'd1', snapshotId: 's1' });
    await exportDraft('d1', 'html');
    expect(invoke).toHaveBeenLastCalledWith('export_draft', { draftId: 'd1', format: 'html' });
    expect(await draftForConversation('c1')).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith('draft_for_conversation', { conversationId: 'c1' });
  });

  it('send the sources commands with camelCase args', async () => {
    const sources = { webSearch: true, researchRunIds: ['run-1'] };
    await setDraftSources('d1', sources);
    expect(invoke).toHaveBeenLastCalledWith('set_draft_sources', { draftId: 'd1', sources });
    await listResearchReports();
    expect(invoke).toHaveBeenLastCalledWith('list_research_reports');
    await getDraftResearchMaterial('d1');
    expect(invoke).toHaveBeenLastCalledWith('get_draft_research_material', { draftId: 'd1' });
  });
});
