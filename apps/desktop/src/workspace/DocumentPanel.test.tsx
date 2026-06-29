import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Artifact, FileState } from '../ipc/contracts';
import { DocumentPanel } from './DocumentPanel';

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
      openArtifacts={[baseArtifact]}
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

function openOverflowMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

describe('DocumentPanel Source tab (M3)', () => {
  it('edits inline text and Save overwrites the payload as Text with the existing mimeType', async () => {
    const { onSaveContent } = renderPanel();
    const ta = screen.getByLabelText('Edit Markdown source') as HTMLTextAreaElement;
    expect(ta.value).toBe('# Hello\n\nworld');

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
      openArtifacts: [fileArtifact],
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
    openOverflowMenu();
    const exportBtn = screen.getByRole('menuitem', { name: 'Export' });
    fireEvent.click(exportBtn);
    await waitFor(() => expect(onExport).toHaveBeenCalledWith('a1', false));

    openOverflowMenu();
    const toggle = screen.getByLabelText('Include metadata sidecar') as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export' }));
    await waitFor(() => expect(onExport).toHaveBeenLastCalledWith('a1', true));
  });
});

describe('DocumentPanel chrome', () => {
  it('shows a minimal empty state without header chrome', () => {
    render(
      <DocumentPanel
        artifact={null}
        openArtifacts={[]}
        fileStateMap={{}}
        activeFileState="noFileContent"
        allowlist={[]}
        docTab="preview"
        onSelectTab={vi.fn()}
        onOpenArtifact={vi.fn()}
        onSaveContent={vi.fn()}
        onExport={vi.fn()}
      />,
    );
    expect(screen.getByText('No artifact open')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('shows title in toolbar when only one artifact is open', () => {
    renderPanel({ docTab: 'preview' });
    expect(screen.getByText('Note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close Note' })).not.toBeInTheDocument();
  });

  it('shows artifact tabs when multiple artifacts are open', () => {
    const second: Artifact = { ...baseArtifact, id: 'a2', title: 'Second' };
    renderPanel({ openArtifacts: [baseArtifact, second], docTab: 'preview', onCloseTab: vi.fn() });
    expect(screen.getByRole('button', { name: 'Close Note' })).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('calls onCollapsePanel when the hide button is clicked', () => {
    const onCollapsePanel = vi.fn();
    renderPanel({ onCollapsePanel, docTab: 'preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide artifact panel' }));
    expect(onCollapsePanel).toHaveBeenCalledTimes(1);
  });

  it('calls onCloseTab when a tab close control is clicked', () => {
    const onCloseTab = vi.fn();
    const second: Artifact = { ...baseArtifact, id: 'a2', title: 'Second' };
    renderPanel({ onCloseTab, openArtifacts: [baseArtifact, second], docTab: 'preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Note' }));
    expect(onCloseTab).toHaveBeenCalledWith('a1');
  });

  it('opens details from the overflow menu', () => {
    renderPanel({ docTab: 'preview' });
    openOverflowMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Details' }));
    expect(screen.getByLabelText('Artifact details')).toBeInTheDocument();
    expect(screen.getByText('Path')).toBeInTheDocument();
  });
});
