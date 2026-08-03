import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { Artifact, FileState } from '../ipc/contracts';
import { DocumentPanel } from './DocumentPanel';

vi.mock('../ipc/client', () => ({
  getArtifactContentBytes: vi.fn().mockResolvedValue([]),
  readArtifactFileBytes: vi.fn().mockResolvedValue([]),
  revealArtifact: vi.fn().mockResolvedValue(undefined),
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
  it('Save a copy… calls onExport with the artifact id and the metadata pref (default on)', async () => {
    const { onExport } = renderPanel();
    openOverflowMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save a copy…' }));
    await waitFor(() => expect(onExport).toHaveBeenCalledWith('a1', true));
  });

  it('honours the export-metadata pref when off', async () => {
    localStorage.setItem('conduit:v7-export-metadata', 'off');
    try {
      const { onExport } = renderPanel();
      openOverflowMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Save a copy…' }));
      await waitFor(() => expect(onExport).toHaveBeenCalledWith('a1', false));
    } finally {
      localStorage.removeItem('conduit:v7-export-metadata');
    }
  });
});

describe('DocumentPanel V7 chrome', () => {
  it('⋯ menu carries the actions and a metadata block (no details column)', () => {
    renderPanel({ docTab: 'preview' });
    openOverflowMenu();
    expect(screen.getByRole('menuitem', { name: 'Copy contents' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Save a copy…' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Reveal in Explorer' })).toBeDisabled();
    // Metadata block: path label + size · modified row.
    expect(screen.getAllByText('(inline payload)').length).toBeGreaterThan(0);
    expect(screen.getByText(/14 B · modified/)).toBeInTheDocument();
    // The V6 details column is gone.
    expect(screen.queryByRole('button', { name: 'Hide details' })).not.toBeInTheDocument();
    expect(document.querySelector('.doc-details')).toBeNull();
  });

  it('shows a version tail in the metadata block when the sidecar has one', () => {
    const versioned: Artifact = { ...baseArtifact, metadata: { version: 3 } };
    renderPanel({ artifact: versioned, openArtifacts: [versioned], docTab: 'preview' });
    openOverflowMenu();
    expect(screen.getByText('v3')).toBeInTheDocument();
  });

  it('renders the persistent foot strip with path and size · saved', () => {
    renderPanel({ docTab: 'preview' });
    const foot = screen.getByLabelText('Artifact metadata');
    expect(foot).toHaveTextContent('(inline payload)');
    expect(foot).toHaveTextContent(/14 B/);
    expect(foot).toHaveTextContent(/saved/);
  });
});

describe('DocumentPanel chrome', () => {
  it('shows the artifact empty state when no artifact is open', () => {
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
    expect(screen.getByText('Artifacts live here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows collapse control on the empty state when provided', () => {
    const onCollapsePanel = vi.fn();
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
        onCollapsePanel={onCollapsePanel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Hide artifact panel' }));
    expect(onCollapsePanel).toHaveBeenCalledTimes(1);
  });

  it('shows a close control when only one artifact is open', () => {
    const onCloseTab = vi.fn();
    renderPanel({ docTab: 'preview', onCloseTab });
    expect(screen.getByText('Note')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Note' }));
    expect(onCloseTab).toHaveBeenCalledWith('a1');
  });

  it('offers Close in the overflow menu for a single open artifact', () => {
    const onCloseTab = vi.fn();
    renderPanel({ docTab: 'preview', onCloseTab });
    openOverflowMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close' }));
    expect(onCloseTab).toHaveBeenCalledWith('a1');
  });

  it('shows a generating placeholder when a create is pending', () => {
    renderPanel({
      artifact: null,
      openArtifacts: [],
      pendingArtifact: {
        kind: 'html',
        title: 'API Overview',
        toolName: 'write_html_document',
        mode: 'create',
      },
      docTab: 'preview',
    });
    expect(screen.getByText(/Generating html document/i)).toBeInTheDocument();
    expect(screen.getByText('API Overview')).toBeInTheDocument();
    expect(screen.queryByText('Artifacts live here')).not.toBeInTheDocument();
  });

  it('shows an updating banner when an edit is pending on an open artifact', () => {
    renderPanel({
      docTab: 'preview',
      pendingArtifact: {
        kind: 'markdown',
        toolName: 'edit_markdown_document',
        mode: 'edit',
        artifactId: 'a1',
      },
    });
    expect(screen.getByText(/Updating document/i)).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
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

  it('uses sibling close buttons without nesting interactive controls in the tab select', () => {
    const second: Artifact = { ...baseArtifact, id: 'a2', title: 'Second' };
    renderPanel({
      openArtifacts: [baseArtifact, second],
      docTab: 'preview',
      onCloseTab: vi.fn(),
      onRenameArtifact: vi.fn(),
    });
    const closeBtn = screen.getByRole('button', { name: 'Close Note' });
    expect(closeBtn.closest('button.tab-select')).toBeNull();
    expect(closeBtn.closest('.artifact-file-tab')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Rename Note' })).toBeInTheDocument();
  });
});
