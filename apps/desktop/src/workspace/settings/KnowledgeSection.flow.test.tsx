import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AppSettings } from '@conduit/config-schema';

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

const importKnowledgeDocument = vi.fn(async (_c: string, path: string) => ({
  status: 'imported' as const,
  documentId: path,
  chunkCount: 1,
  title: path.split('/').pop()!,
}));
const updateSettings = vi.fn(async (patch: Partial<AppSettings>) => ({ ...current, ...patch }) as AppSettings);
let current: AppSettings;

vi.mock('../../ipc/client', () => ({
  listKnowledgeCollections: vi.fn(async () => [collection]),
  listKnowledgeDocuments: vi.fn(async () => []),
  pickKnowledgeDocument: vi.fn(),
  importKnowledgeDocument: (c: string, p: string) => importKnowledgeDocument(c, p),
  updateSettings: (patch: Partial<AppSettings>) => updateSettings(patch),
  createKnowledgeCollection: vi.fn(),
  deleteKnowledgeCollection: vi.fn(),
  deleteKnowledgeDocument: vi.fn(),
  renameKnowledgeCollection: vi.fn(),
}));

const { KnowledgeSection } = await import('./KnowledgeSection');

function settingsWith(overrides: Partial<AppSettings>): AppSettings {
  return {
    embeddingConsentProviders: [],
    pdfImportNoticeAcknowledged: false,
    ...overrides,
  } as unknown as AppSettings;
}

describe('KnowledgeSection import flow', () => {
  beforeEach(() => {
    importKnowledgeDocument.mockClear();
    updateSettings.mockClear();
  });

  /** A batch of dropped files asks each one-time question once, in order — the
   *  PDF notice (local) before consent (leaves the machine) — then imports
   *  every file. */
  it('asks once per batch, then imports every dropped file', async () => {
    current = settingsWith({});
    const handled = vi.fn();
    render(
      <KnowledgeSection
        settings={current}
        onUpdate={(next) => (current = next)}
        onStatus={vi.fn()}
        pendingPaths={['C:/docs/manual.pdf', 'C:/docs/notes.md']}
        onPendingPathsHandled={handled}
      />,
    );

    expect(await screen.findByText(/Add these 2 files to a collection/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(handled).toHaveBeenCalled();

    // PDF notice first, then consent — each exactly once for two files.
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));

    await waitFor(() => expect(importKnowledgeDocument).toHaveBeenCalledTimes(2));
    expect(importKnowledgeDocument.mock.calls.map((c) => c[1])).toEqual([
      'C:/docs/manual.pdf',
      'C:/docs/notes.md',
    ]);
    expect(updateSettings).toHaveBeenCalledWith({ pdfImportNoticeAcknowledged: true });
    expect(updateSettings).toHaveBeenCalledWith({ embeddingConsentProviders: ['openrouter'] });
  });

  it('imports nothing when consent is declined', async () => {
    current = settingsWith({ pdfImportNoticeAcknowledged: true });
    const onStatus = vi.fn();
    render(
      <KnowledgeSection
        settings={current}
        onUpdate={vi.fn()}
        onStatus={onStatus}
        pendingPaths={['C:/docs/notes.md']}
        onPendingPathsHandled={vi.fn()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));

    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Document was not added'));
    expect(importKnowledgeDocument).not.toHaveBeenCalled();
  });

  /** The backend always supported withdrawal (the patch is a full replace);
   *  t1-6 shipped with no way to reach it. */
  it('lists providers with consent and revokes one', async () => {
    current = settingsWith({ embeddingConsentProviders: ['openrouter', 'openai'] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<KnowledgeSection settings={current} onUpdate={vi.fn()} onStatus={vi.fn()} />);

    expect(await screen.findByText('Providers that can receive document text')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0]);

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ embeddingConsentProviders: ['openai'] }),
    );
  });
});
