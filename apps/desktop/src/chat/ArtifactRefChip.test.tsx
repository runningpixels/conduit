import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AssistantArtifactStrip } from './ArtifactRefChip';

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

  it('shows chips for artifacts linked to the message', () => {
    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(screen.getByText('Demo')).toBeInTheDocument();
  });

  it('opens the artifact when the chip is clicked', () => {
    const onOpenArtifact = vi.fn();
    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    fireEvent.click(screen.getByText('Demo'));
    expect(onOpenArtifact).toHaveBeenCalledWith('art-1');
  });
});
