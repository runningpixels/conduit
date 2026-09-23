import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AppSettings } from '@conduit/config-schema';
import type { KnowledgeImportProgress } from '../../ipc/contracts';

const collection = {
  id: 'c1',
  name: 'Garden',
  providerId: 'openrouter',
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingDimensions: 1536,
  documentCount: 0,
  createdAt: '2026-09-22T00:00:00Z',
  updatedAt: '2026-09-22T00:00:00Z',
};

/** Resolves only when the test says so, so the import can be observed mid-flight. */
let releaseImport: (() => void) | null = null;
let emit: ((p: KnowledgeImportProgress) => void) | null = null;

vi.mock('../../ipc/client', () => ({
  listKnowledgeCollections: vi.fn(async () => [collection]),
  listKnowledgeDocuments: vi.fn(async () => []),
  pickKnowledgeDocument: vi.fn(async () => 'C:/docs/notes.md'),
  importKnowledgeDocument: vi.fn(
    async (_id: string, _path: string, onProgress?: (p: KnowledgeImportProgress) => void) => {
      emit = onProgress ?? null;
      await new Promise<void>((resolve) => {
        releaseImport = resolve;
      });
      return { status: 'imported', documentId: 'd1', chunkCount: 181, title: 'notes.md' };
    },
  ),
  createKnowledgeCollection: vi.fn(),
  deleteKnowledgeCollection: vi.fn(),
  deleteKnowledgeDocument: vi.fn(),
  renameKnowledgeCollection: vi.fn(),
  updateSettings: vi.fn(),
}));

const { KnowledgeSection } = await import('./KnowledgeSection');

const settings = {
  embeddingConsentProviders: ['openrouter'],
  pdfImportNoticeAcknowledged: true,
} as unknown as AppSettings;

describe('KnowledgeSection import progress', () => {
  beforeEach(() => {
    releaseImport = null;
    emit = null;
  });

  /**
   * Importing a large PDF spends most of its time waiting on the provider —
   * measured at ~5s reading then ~3s embedding for a 181-chunk deck, and over
   * 30s when the provider is slow. Without this the Import button just sits
   * there and the app looks hung.
   */
  it('shows the reading phase, then a determinate bar, and clears when done', async () => {
    render(<KnowledgeSection settings={settings} onUpdate={vi.fn()} onStatus={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /import document/i }));

    // Reading: no chunk count is known yet, so the bar must not claim a value.
    await waitFor(() => expect(screen.getByRole('progressbar')).toBeTruthy());
    expect(screen.getByText(/reading the document/i)).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull();

    emit?.({ phase: 'embedding', chunksDone: 64, chunksTotal: 181 });
    await waitFor(() => expect(screen.getByText(/64 of 181/)).toBeTruthy());
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('35');

    releaseImport?.();
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
  });
});
