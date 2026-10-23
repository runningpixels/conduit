/**
 * "Have it reviewed" (⋯ menu): offered for a chat document when the shell
 * passes `onReview`, shown as under way while a review runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Artifact, FileState } from '../ipc/contracts';
import { DocumentPanel } from './DocumentPanel';

const ipc = vi.hoisted(() => ({
  getArtifactContentBytes: vi.fn().mockResolvedValue([]),
  readArtifactFileBytes: vi.fn().mockResolvedValue([]),
  revealPath: vi.fn().mockResolvedValue(undefined),
  parseBrandSource: vi.fn().mockRejectedValue(new Error('not a brand')),
  setBrandConfig: vi.fn(),
  getArtifactNetworkState: vi.fn().mockResolvedValue({ blockedReason: null, always: [], session: [], fullAccess: false }),
  pageLlmState: vi.fn().mockResolvedValue({
    providerId: 'anthropic',
    providerName: 'Anthropic',
    isLocal: false,
    blockedReason: null,
    granted: null,
  }),
  artifactPrincipal: (id: string) => `artifact:${id}`,
}));
vi.mock('../ipc/client', () => ipc);

const doc = (over: Partial<Artifact> = {}): Artifact => ({
  id: 'a1',
  conversationId: 'c1',
  kind: 'markdown',
  title: 'Heater email',
  sourceMessageId: 'm1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mimeType: 'text/markdown',
  contentText: 'Dear landlord',
  contentHash: 'h',
  sizeBytes: 13,
  ...over,
});

function renderPanel(artifact: Artifact, extra: Partial<React.ComponentProps<typeof DocumentPanel>> = {}) {
  return render(
    <DocumentPanel
      artifact={artifact}
      openArtifacts={[artifact]}
      fileStateMap={{ a1: 'ok' as FileState }}
      activeFileState="ok"
      allowlist={[]}
      docTab="preview"
      onSelectTab={vi.fn()}
      onOpenArtifact={vi.fn()}
      onSaveContent={vi.fn().mockResolvedValue(undefined)}
      onExport={vi.fn().mockResolvedValue(undefined)}
      {...extra}
    />,
  );
}

async function openMenu() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'More actions' })).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DocumentPanel "Have it reviewed"', () => {
  it('hands the document to the shell', async () => {
    const onReview = vi.fn();
    const artifact = doc();
    renderPanel(artifact, { onReview });
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Have it reviewed' }));
    expect(onReview).toHaveBeenCalledWith(artifact);
  });

  it('says a review is under way and cannot start another', async () => {
    renderPanel(doc(), { onReview: vi.fn(), reviewing: true });
    await openMenu();
    expect(await screen.findByRole('menuitem', { name: 'Reviewing…' })).toBeDisabled();
  });

  it('is not offered without the shell, or for something that is not a document', async () => {
    const { unmount } = renderPanel(doc());
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Have it reviewed' })).toBeNull();
    unmount();
    renderPanel(doc({ kind: 'code', mimeType: 'text/plain' }), { onReview: vi.fn() });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Have it reviewed' })).toBeNull();
  });
});
