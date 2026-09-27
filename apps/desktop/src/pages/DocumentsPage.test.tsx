import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { AppSettings } from '@conduit/config-schema';

function collection(id: string, name: string, documentCount: number) {
  return {
    id,
    name,
    providerId: 'openrouter',
    embeddingModel: 'openai/text-embedding-3-small',
    embeddingDimensions: 1536,
    documentCount,
    createdAt: '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T00:00:00Z',
  };
}

function doc(id: string, collectionId: string, title: string, source: string) {
  return {
    id,
    collectionId,
    source,
    title,
    mimeType: null,
    byteSize: 2048,
    chunkCount: 12,
    importedAt: new Date().toISOString(),
  };
}

let collections = [collection('c1', 'Garden', 2), collection('c2', 'Taxes', 1)];
const docsByCollection: Record<string, ReturnType<typeof doc>[]> = {
  c1: [doc('d1', 'c1', 'Roses', 'C:/docs/roses.pdf'), doc('d2', 'c1', 'Soil', 'C:/docs/soil.md')],
  c2: [doc('d3', 'c2', 'Receipts', 'C:/docs/receipts.txt')],
};

const client = vi.hoisted(() => ({
  listKnowledgeCollections: vi.fn(),
  listKnowledgeDocuments: vi.fn(),
  pickKnowledgeDocument: vi.fn(),
  importKnowledgeDocument: vi.fn(),
  updateSettings: vi.fn(),
  createKnowledgeCollection: vi.fn(),
  deleteKnowledgeCollection: vi.fn(),
  deleteKnowledgeDocument: vi.fn(),
  renameKnowledgeCollection: vi.fn(),
}));
vi.mock('../ipc/client', () => client);

const { DocumentsPage } = await import('./DocumentsPage');

const settings = {
  embeddingConsentProviders: ['openrouter'],
  pdfImportNoticeAcknowledged: true,
} as unknown as AppSettings;

function renderPage(pendingPaths: string[] = []) {
  const onPendingPathsHandled = vi.fn();
  render(
    <DocumentsPage
      settings={settings}
      onSettingsChange={vi.fn()}
      onStatus={vi.fn()}
      pendingPaths={pendingPaths}
      onPendingPathsHandled={onPendingPathsHandled}
    />,
  );
  return { onPendingPathsHandled };
}

describe('DocumentsPage', () => {
  beforeEach(() => {
    collections = [collection('c1', 'Garden', 2), collection('c2', 'Taxes', 1)];
    client.listKnowledgeCollections.mockImplementation(async () => collections);
    client.listKnowledgeDocuments.mockImplementation(async (id: string) => docsByCollection[id] ?? []);
    client.createKnowledgeCollection.mockImplementation(async (name: string) => {
      const created = collection('c3', name, 0);
      collections = [...collections, created];
      return created;
    });
    client.deleteKnowledgeCollection.mockResolvedValue(undefined);
    client.deleteKnowledgeDocument.mockResolvedValue(undefined);
    client.renameKnowledgeCollection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('lists collections and selects the first by default, showing its documents', async () => {
    renderPage();
    const list = await screen.findByRole('navigation', { name: 'Collections' });
    const garden = await within(list).findByRole('button', { name: /Garden/ });
    expect(garden.getAttribute('aria-current')).toBe('true');
    expect(within(list).getByText('2 documents · openrouter')).toBeTruthy();

    expect(await screen.findByRole('heading', { name: 'Garden' })).toBeTruthy();
    expect(screen.getByText('Embedded by openrouter · openai/text-embedding-3-small')).toBeTruthy();
    expect(await screen.findByText('Roses')).toBeTruthy();
    expect(screen.getByText('Soil')).toBeTruthy();
    expect(screen.getAllByText('12 sections')).toHaveLength(2);
    expect(screen.getByText(/PDF · added/)).toBeTruthy();
    expect(screen.getByText('Document text is sent to openrouter for indexing.')).toBeTruthy();
  });

  it('shows the selected collection’s documents when another is picked', async () => {
    renderPage();
    const list = await screen.findByRole('navigation', { name: 'Collections' });
    fireEvent.click(await within(list).findByRole('button', { name: /Taxes/ }));

    expect(await screen.findByRole('heading', { name: 'Taxes' })).toBeTruthy();
    expect(await screen.findByText('Receipts')).toBeTruthy();
    expect(screen.queryByText('Roses')).toBeNull();
    expect(client.listKnowledgeDocuments).toHaveBeenLastCalledWith('c2');
    expect(within(list).getByRole('button', { name: /Taxes/ }).getAttribute('aria-current')).toBe('true');
  });

  it('shows an empty state with a create action when there are no collections', async () => {
    collections = [];
    vi.spyOn(window, 'prompt').mockReturnValue('Recipes');
    renderPage();

    expect(await screen.findByText('A collection groups files the assistant can search. Create one, then import documents into it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create a collection' }));

    await waitFor(() => expect(client.createKnowledgeCollection).toHaveBeenCalledWith('Recipes'));
    expect(await screen.findByRole('heading', { name: 'Recipes' })).toBeTruthy();
  });

  it('creates a collection from the header action', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Recipes');
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New collection' }));
    await waitFor(() => expect(client.createKnowledgeCollection).toHaveBeenCalledWith('Recipes'));
  });

  it('renames and deletes only after confirmation', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Yard');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await screen.findByRole('heading', { name: 'Garden' });

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(prompt).toHaveBeenCalledWith('Rename this collection', 'Garden');
    await waitFor(() => expect(client.renameKnowledgeCollection).toHaveBeenCalledWith('c1', 'Yard'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(confirm).toHaveBeenCalled();
    expect(client.deleteKnowledgeCollection).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(client.deleteKnowledgeCollection).toHaveBeenCalledWith('c1'));
  });

  it('removes a document after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Roses' }));
    await waitFor(() => expect(client.deleteKnowledgeDocument).toHaveBeenCalledWith('d1'));
  });

  it('offers dropped files to the selected collection by default', async () => {
    renderPage(['C:/docs/notes.md']);
    const banner = await screen.findByRole('region', { name: 'Dropped files' });
    expect(within(banner).getByText('notes.md')).toBeTruthy();
    await waitFor(() =>
      expect((within(banner).getByRole('combobox') as HTMLSelectElement).value).toBe('c1'),
    );
  });

  it('asks for a collection first when files are dropped with none', async () => {
    collections = [];
    const { onPendingPathsHandled } = renderPage(['C:/docs/notes.md']);
    expect(await screen.findByText('Create a collection first, then add the files to it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onPendingPathsHandled).toHaveBeenCalled();
  });
});
