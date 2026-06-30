import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AssistantArtifactStrip } from './ArtifactRefChip';
import { detectArtifactCandidates } from './artifactCandidates';
import type { Artifact } from '../ipc/contracts';

const htmlContent = 'Here is the page:\n```html\n<html><title>Demo</title></html>\n```';
const htmlCandidateKey = detectArtifactCandidates(htmlContent)[0]?.key ?? 'cand-0';

const promotedArtifact: Artifact = {
  id: 'art-1',
  conversationId: 'conv-1',
  kind: 'html',
  title: 'Demo',
  sourceMessageId: 'msg-1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mimeType: 'text/html',
  contentHash: 'h',
  sizeBytes: 10,
};

describe('AssistantArtifactStrip', () => {
  it('hides HTML promote button when an HTML artifact is already linked', () => {
    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        content={htmlContent}
        onPromote={vi.fn()}
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Promote HTML/i })).toBeNull();
    expect(screen.getByText('Demo')).toBeInTheDocument();
  });

  it('hides suppressed candidates while auto-promotion is in flight', () => {
    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[]}
        content={htmlContent}
        suppressedCandidateKeys={new Set([htmlCandidateKey])}
        onPromote={vi.fn()}
        onOpenArtifact={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Promote HTML/i })).toBeNull();
  });

  it('opens the artifact when the chip is clicked', () => {
    const onOpenArtifact = vi.fn();
    render(
      <AssistantArtifactStrip
        messageId="msg-1"
        artifacts={[promotedArtifact]}
        content={htmlContent}
        onPromote={vi.fn()}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    fireEvent.click(screen.getByText('Demo'));
    expect(onOpenArtifact).toHaveBeenCalledWith('art-1');
  });
});
