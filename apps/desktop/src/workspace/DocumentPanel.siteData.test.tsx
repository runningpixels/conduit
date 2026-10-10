/**
 * "Clear site data" for a chat page with full web access (ADR-007): offered in
 * the ⋯ menu only when the page has its own origin, asked first, then cleared.
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
  getArtifactNetworkState: vi.fn(),
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
const site = vi.hoisted(() => ({
  clearPageSiteData: vi.fn(async () => true),
  sweepPageSiteData: vi.fn(async () => {}),
}));
vi.mock('../artifacts/pageSiteData', () => site);

const page: Artifact = {
  id: 'a1',
  conversationId: 'c1',
  kind: 'html',
  title: 'Map',
  sourceMessageId: 'm1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mimeType: 'text/html',
  contentText: '<p>map</p>',
  contentHash: 'h',
  sizeBytes: 10,
};

function renderPanel(onStatus = vi.fn()) {
  render(
    <DocumentPanel
      artifact={page}
      openArtifacts={[page]}
      fileStateMap={{ a1: 'ok' as FileState }}
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DocumentPanel "Clear site data"', () => {
  it('is offered for a page with full web access, asks first, then clears it', async () => {
    ipc.getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: ['full'], session: [], fullAccess: true });
    const { onStatus } = renderPanel();
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear site data' }));
    expect(site.clearPageSiteData).not.toHaveBeenCalled();
    expect(await screen.findByText('Clear this page’s site data?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(site.clearPageSiteData).toHaveBeenCalledWith('artifact:a1'));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Cleared this page’s site data.'));
  });

  it('is not offered without full web access', async () => {
    ipc.getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: [], session: [], fullAccess: false });
    renderPanel();
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Clear site data' })).toBeNull();
  });
});
