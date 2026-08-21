import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AssistantArtifactStrip } from './ArtifactResultCard';
import { exportArtifact, getArtifactContentBytes, revealPath } from '../ipc/client';

vi.mock('../ipc/client', () => ({
  exportArtifact: vi.fn(),
  getArtifactContentBytes: vi.fn(),
  revealPath: vi.fn(),
}));

const promotedArtifact = {
  id: 'art-1',
  conversationId: 'conv-1',
  kind: 'html' as const,
  title: 'Demo',
  sourceMessageId: 'msg-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mimeType: 'text/html',
  contentHash: 'h',
  sizeBytes: 10,
};

describe('AssistantArtifactStrip', () => {
  beforeEach(() => {
    vi.mocked(exportArtifact).mockReset();
    vi.mocked(getArtifactContentBytes).mockReset();
    vi.mocked(revealPath).mockReset();
  });

  it('renders nothing when no artifacts are linked to the message', () => {
    const { container } = render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[]}
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(container.querySelector('.artifact-strip')).toBeNull();
  });

  it('skips artifacts already shown as a card in the message body', () => {
    // Otherwise the same artifact is reported twice in one turn: once where it
    // was produced, and again at the end of the turn.
    const { container } = render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        excludeArtifactIds={new Set(['art-1'])}
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(container.querySelector('.artifact-strip')).toBeNull();
  });

  it('still shows artifacts that have no in-body card', () => {
    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        excludeArtifactIds={new Set(['other-id'])}
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(screen.getByText('Demo')).toBeInTheDocument();
  });

  it('shows a card for artifacts linked to the message', () => {
    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(screen.getByText('Demo')).toBeInTheDocument();
    // The kind + size subtitle is what makes the card self-describing.
    expect(screen.getByText('HTML · 10 B')).toBeInTheDocument();
  });

  it('opens the artifact from the stated primary action', () => {
    const onOpenArtifact = vi.fn();
    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpenArtifact).toHaveBeenCalledWith('art-1');
  });

  // "Reveal in Explorer" is gone. It was disabled in every real session: artifact
  // payloads live in the database as text, so `contentPath` was never set. These
  // two tests previously asserted that disabled state, and the second had to
  // hand-inject a `contentPath` production never produces.
  it('offers no Reveal action', () => {
    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        onOpenArtifact={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for demo/i }));
    expect(screen.queryByRole('menuitem', { name: /reveal/i })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Copy contents' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: 'Save a copy…' })).toBeEnabled();
  });

  it('exports, then reveals where the file landed', async () => {
    const onStatus = vi.fn();
    vi.mocked(exportArtifact).mockResolvedValue({
      exportedTo: 'C:\\exports\\demo.html',
      bytesWritten: 10,
    });
    vi.mocked(revealPath).mockResolvedValue(undefined);

    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        onOpenArtifact={vi.fn()}
        onStatus={onStatus}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for demo/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save a copy…' }));

    await waitFor(() => expect(revealPath).toHaveBeenCalled());
    expect(exportArtifact).toHaveBeenCalledWith('art-1', expect.any(Boolean));
    expect(onStatus).toHaveBeenCalledWith('Exported to C:\\exports\\demo.html');
  });

  it('still reports the export as succeeded when revealing fails', async () => {
    const onStatus = vi.fn();
    vi.mocked(exportArtifact).mockResolvedValue({
      exportedTo: 'C:\\exports\\demo.html',
      bytesWritten: 10,
    });
    vi.mocked(revealPath).mockRejectedValue(new Error('no file manager'));

    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        onOpenArtifact={vi.fn()}
        onStatus={onStatus}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /more actions for demo/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save a copy…' }));

    // The file is written either way — a failed reveal must not read as a
    // failed export.
    await waitFor(() => expect(revealPath).toHaveBeenCalled());
    expect(onStatus).toHaveBeenCalledWith('Exported to C:\\exports\\demo.html');
    expect(onStatus).not.toHaveBeenCalledWith(expect.stringMatching(/could not/i));
  });
});
