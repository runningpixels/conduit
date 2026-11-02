import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Artifact, FileState } from '../ipc/contracts';
import { DocumentPanel } from './DocumentPanel';

vi.mock('../ipc/client', () => ({
  getArtifactContentBytes: vi.fn().mockResolvedValue([]),
  readArtifactFileBytes: vi.fn().mockResolvedValue([]),
  revealPath: vi.fn().mockResolvedValue(undefined),
  parseBrandSource: vi.fn().mockRejectedValue(new Error('not a brand')),
  setBrandConfig: vi.fn(),
  getSpreadsheetView: vi.fn().mockResolvedValue({
    title: 'Menu board',
    errors: [],
    sheets: [
      {
        name: 'Menu',
        freezeHeader: false,
        columnWidths: [10],
        rowCount: 1,
        colCount: 1,
        truncatedRows: 0,
        rows: [[{ display: 'Latte', kind: 'text' }]],
      },
    ],
  }),
  exportSpreadsheetXlsx: vi.fn(),
}));

import { exportSpreadsheetXlsx } from '../ipc/client';

const sheet: Artifact = {
  id: 'sheet-1',
  conversationId: 'c1',
  kind: 'spreadsheet',
  title: 'Menu board',
  createdAt: '2026-11-02T00:00:00Z',
  updatedAt: '2026-11-02T00:00:00Z',
  mimeType: 'application/json',
  contentJson: { sheets: [{ name: 'Menu', rows: [['Latte']] }] },
  contentHash: 'h',
  sizeBytes: 40,
};

function renderPanel(artifact: Artifact = sheet) {
  const onStatus = vi.fn();
  render(
    <DocumentPanel
      artifact={artifact}
      openArtifacts={[artifact]}
      fileStateMap={{ [artifact.id]: 'ok' as FileState }}
      activeFileState="ok"
      allowlist={[]}
      docTab="preview"
      onSelectTab={vi.fn()}
      onOpenArtifact={vi.fn()}
      onSaveContent={vi.fn().mockResolvedValue(undefined)}
      onExport={vi.fn().mockResolvedValue(undefined)}
      onStatus={onStatus}
    />,
  );
  return { onStatus };
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'More actions' }));

describe('DocumentPanel spreadsheet', () => {
  afterEach(() => {
    cleanup();
    vi.mocked(exportSpreadsheetXlsx).mockReset();
  });

  it('previews the workbook as a grid', async () => {
    renderPanel();
    expect(await screen.findByRole('grid')).toBeInTheDocument();
    expect(screen.getByRole('gridcell', { name: 'Latte' })).toBeInTheDocument();
  });

  it('offers Save as Excel and reports where the file went', async () => {
    vi.mocked(exportSpreadsheetXlsx).mockResolvedValue({ saved: true, path: 'C:\\Users\\me\\Menu board.xlsx' });
    const { onStatus } = renderPanel();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as Excel (.xlsx)…' }));
    await waitFor(() => expect(exportSpreadsheetXlsx).toHaveBeenCalledWith('sheet-1'));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Saved Menu board.xlsx.'));
  });

  it('says nothing when the save dialog is cancelled', async () => {
    vi.mocked(exportSpreadsheetXlsx).mockResolvedValue({ saved: false });
    const { onStatus } = renderPanel();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as Excel (.xlsx)…' }));
    await waitFor(() => expect(exportSpreadsheetXlsx).toHaveBeenCalled());
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('reports a failed export', async () => {
    vi.mocked(exportSpreadsheetXlsx).mockRejectedValue(new Error('disk full'));
    const { onStatus } = renderPanel();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as Excel (.xlsx)…' }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Couldn’t save the Excel file: disk full'));
  });

  it('does not offer Save as Excel for other documents', () => {
    renderPanel({ ...sheet, kind: 'markdown', mimeType: 'text/markdown', contentJson: undefined, contentText: '# Hi' });
    openMenu();
    expect(screen.queryByRole('menuitem', { name: /Excel/ })).toBeNull();
  });
});
