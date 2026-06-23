import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Artifact, FileState } from '../ipc/contracts';
import { DocumentPanel } from './DocumentPanel';

/// M3: the Source tab edits inline text and Save overwrites the single payload
/// via `onSaveContent`. The panel reads File-content bytes through the IPC
/// client; mock it so no Tauri bridge is touched.
vi.mock('../ipc/client', () => ({
  getArtifactContentBytes: vi.fn().mockResolvedValue([]),
  readArtifactFileBytes: vi.fn().mockResolvedValue([]),
}));

import { getArtifactContentBytes, readArtifactFileBytes } from '../ipc/client';

const baseArtifact: Artifact = {
  id: 'a1',
  conversationId: 'c1',
  kind: 'markdown',
  title: 'Note',
  sourceMessageId: 'm1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mimeType: 'text/markdown',
  contentText: '# Hello\n\nworld',
  contentHash: 'h',
  sizeBytes: 14,
};

function renderPanel(overrides: Partial<Parameters<typeof DocumentPanel>[0]> = {}) {
  const onSaveContent = vi.fn().mockResolvedValue(undefined);
  const onExport = vi.fn().mockResolvedValue(undefined);
  const onSelectTab = vi.fn();
  const onOpenArtifact = vi.fn();
  render(
    <DocumentPanel
      artifact={baseArtifact}
      artifacts={[baseArtifact]}
      fileStateMap={{ a1: 'ok' as FileState }}
      activeFileState="ok"
      allowlist={[]}
      docTab="source"
      onSelectTab={onSelectTab}
      onOpenArtifact={onOpenArtifact}
      onSaveContent={onSaveContent}
      onExport={onExport}
      {...overrides}
    />,
  );
  return { onSaveContent, onExport };
}

describe('DocumentPanel Source tab (M3)', () => {
  it('edits inline text and Save overwrites the payload as Text with the existing mimeType', async () => {
    const { onSaveContent } = renderPanel();
    const ta = screen.getByLabelText('Edit Markdown source') as HTMLTextAreaElement;
    expect(ta.value).toBe('# Hello\n\nworld');

    // Save is disabled until dirty.
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();

    fireEvent.change(ta, { target: { value: '# Hello\n\nedited world' } });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(onSaveContent).toHaveBeenCalledWith('a1', { kind: 'text', text: '# Hello\n\nedited world' }, 'text/markdown'),
    );
  });

  it('does not call Save when the draft is unchanged', async () => {
    const { onSaveContent } = renderPanel();
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();
    fireEvent.click(saveBtn);
    expect(onSaveContent).not.toHaveBeenCalled();
  });

  it('Use disk re-saves the on-disk bytes as a File payload with the path filename', async () => {
    const fileArtifact: Artifact = { ...baseArtifact, id: 'a2', contentPath: 'a2/report.txt', mimeType: 'text/plain', contentText: undefined };
    const { onSaveContent } = renderPanel({
      artifact: fileArtifact,
      artifacts: [fileArtifact],
      fileStateMap: { a2: 'modified' as FileState },
      activeFileState: 'modified',
    });
    (readArtifactFileBytes as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([10, 20, 30]);

    const useDiskBtn = await screen.findByRole('button', { name: 'Use disk' });
    fireEvent.click(useDiskBtn);
    await waitFor(() =>
      expect(onSaveContent).toHaveBeenCalledWith('a2', { kind: 'file', bytes: [10, 20, 30], filename: 'report.txt' }, 'text/plain'),
    );
  });
});

describe('DocumentPanel Export (M5)', () => {
  it('Export calls onExport with the artifact id and the metadata toggle state', async () => {
    const { onExport } = renderPanel();
    const exportBtn = screen.getByRole('button', { name: 'Export' });
    fireEvent.click(exportBtn);
    await waitFor(() => expect(onExport).toHaveBeenCalledWith('a1', false));

    const toggle = screen.getByLabelText('Include metadata sidecar') as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    fireEvent.click(exportBtn);
    await waitFor(() => expect(onExport).toHaveBeenLastCalledWith('a1', true));
  });
});