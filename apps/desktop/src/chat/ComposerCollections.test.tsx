import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { KnowledgeCollection, KnowledgeDocument } from '../ipc/contracts';

const listKnowledgeDocuments = vi.fn<(collectionId: string) => Promise<KnowledgeDocument[]>>();
vi.mock('../ipc/client', () => ({
  listKnowledgeDocuments: (collectionId: string) => listKnowledgeDocuments(collectionId),
}));

const { ComposerCollections } = await import('./ComposerCollections');

const collection: KnowledgeCollection = {
  id: 'c1',
  name: 'Greenhouse',
  providerId: 'openrouter',
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingDimensions: 1536,
  documentCount: 2,
  createdAt: '2026-09-20T00:00:00Z',
  updatedAt: '2026-09-20T00:00:00Z',
};

function doc(id: string, title: string): KnowledgeDocument {
  return {
    id,
    collectionId: 'c1',
    source: `/greenhouse/${title}`,
    title,
    mimeType: 'text/plain',
    byteSize: 10,
    chunkCount: 1,
    importedAt: '2026-09-20T00:00:00Z',
  };
}

describe('ComposerCollections', () => {
  beforeEach(() => {
    listKnowledgeDocuments.mockReset();
    listKnowledgeDocuments.mockResolvedValue([]);
  });

  it('toggles a collection on and off with the switch', () => {
    const onToggle = vi.fn();
    render(
      <ComposerCollections
        open
        streaming={false}
        collections={[collection]}
        enabledIds={[]}
        onClose={vi.fn()}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Greenhouse' }));
    expect(onToggle).toHaveBeenCalledWith('c1', true);
  });

  it('disables an attached collection from the switch', () => {
    const onToggle = vi.fn();
    render(
      <ComposerCollections
        open
        streaming={false}
        collections={[collection]}
        enabledIds={['c1']}
        onClose={vi.fn()}
        onToggle={onToggle}
      />,
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Disable Greenhouse' }));
    expect(onToggle).toHaveBeenCalledWith('c1', false);
  });

  it('shows no expand affordance for an attached collection without a document handler', () => {
    render(
      <ComposerCollections
        open
        streaming={false}
        collections={[collection]}
        enabledIds={['c1']}
        onClose={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /show documents/i })).toBeNull();
  });

  it('lazy-loads documents on first expand and lists them with checkboxes', async () => {
    listKnowledgeDocuments.mockResolvedValue([doc('d1', 'notes.md'), doc('d2', 'stale.md')]);
    render(
      <ComposerCollections
        open
        streaming={false}
        collections={[collection]}
        enabledIds={['c1']}
        excludedDocumentIds={[]}
        onToggleDocument={vi.fn()}
        onClose={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    expect(listKnowledgeDocuments).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Show documents in Greenhouse' }));
    expect(listKnowledgeDocuments).toHaveBeenCalledWith('c1');
    expect(await screen.findByRole('checkbox', { name: 'notes.md' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'stale.md' })).toBeInTheDocument();
    // Collapsing and re-expanding does not fetch a second time.
    fireEvent.click(screen.getByRole('button', { name: 'Hide documents in Greenhouse' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show documents in Greenhouse' }));
    expect(listKnowledgeDocuments).toHaveBeenCalledTimes(1);
  });

  it('unchecking a document calls the handler to exclude it, checking calls it to include', async () => {
    listKnowledgeDocuments.mockResolvedValue([doc('d1', 'notes.md'), doc('d2', 'stale.md')]);
    const onToggleDocument = vi.fn();
    render(
      <ComposerCollections
        open
        streaming={false}
        collections={[collection]}
        enabledIds={['c1']}
        excludedDocumentIds={['d2']}
        onToggleDocument={onToggleDocument}
        onClose={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show documents in Greenhouse' }));
    const notes = await screen.findByRole('checkbox', { name: 'notes.md' });
    const stale = screen.getByRole('checkbox', { name: 'stale.md' });
    expect(notes).toBeChecked();
    expect(stale).not.toBeChecked();

    fireEvent.click(notes);
    expect(onToggleDocument).toHaveBeenCalledWith('d1', true);

    fireEvent.click(stale);
    expect(onToggleDocument).toHaveBeenCalledWith('d2', false);
  });

  it('shows "n of m documents" once loaded documents reveal an exclusion', async () => {
    listKnowledgeDocuments.mockResolvedValue([doc('d1', 'notes.md'), doc('d2', 'stale.md')]);
    render(
      <ComposerCollections
        open
        streaming={false}
        collections={[collection]}
        enabledIds={['c1']}
        excludedDocumentIds={['d2']}
        onToggleDocument={vi.fn()}
        onClose={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    // Before loading, the plain document count still shows.
    expect(screen.getByText('2 documents')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show documents in Greenhouse' }));
    await waitFor(() => expect(screen.getByText('1 of 2 documents')).toBeInTheDocument());
  });

  it('does not show the "n of m" note when nothing in the collection is excluded', async () => {
    listKnowledgeDocuments.mockResolvedValue([doc('d1', 'notes.md'), doc('d2', 'stale.md')]);
    render(
      <ComposerCollections
        open
        streaming={false}
        collections={[collection]}
        enabledIds={['c1']}
        excludedDocumentIds={[]}
        onToggleDocument={vi.fn()}
        onClose={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show documents in Greenhouse' }));
    await screen.findByRole('checkbox', { name: 'notes.md' });
    expect(screen.queryByText(/of 2 documents/)).toBeNull();
    expect(screen.getByText('2 documents')).toBeInTheDocument();
  });

  it('the expand button is a real, keyboard-reachable button', () => {
    render(
      <ComposerCollections
        open
        streaming={false}
        collections={[collection]}
        enabledIds={['c1']}
        onToggleDocument={vi.fn()}
        onClose={vi.fn()}
        onToggle={vi.fn()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Show documents in Greenhouse' });
    expect(button.tagName).toBe('BUTTON');
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
  });
});
