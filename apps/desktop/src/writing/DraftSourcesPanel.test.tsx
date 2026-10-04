import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DraftSourcesPanel, type DraftSourcesPanelProps } from './DraftSourcesPanel';
import { draftWebSearchActive, draftWebSearchUnavailableReasonId } from './draftSources';

function props(over: Partial<DraftSourcesPanelProps> = {}): DraftSourcesPanelProps {
  return {
    webSearch: false,
    webDisabledReason: null,
    onToggleWeb: vi.fn(),
    collections: [
      {
        id: 'k1',
        name: 'Team docs',
        providerId: 'openai',
        embeddingModel: 'm',
        embeddingDimensions: 3,
        documentCount: 4,
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      },
    ],
    enabledCollectionIds: [],
    onToggleCollection: vi.fn(),
    reports: [{ runId: 'run-1', question: 'Build speed?', citedSources: 5, claims: 12 }],
    attachedRunIds: ['run-1'],
    onToggleReport: vi.fn(),
    ...over,
  };
}

describe('DraftSourcesPanel', () => {
  it('turns each source on and off through its handler', () => {
    const p = props();
    render(<DraftSourcesPanel {...p} />);
    expect(screen.getByText('Facts from sources are linked in the draft. Anything without a source is marked TODO.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Web search' }));
    expect(p.onToggleWeb).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /Team docs/ }));
    expect(p.onToggleCollection).toHaveBeenCalledWith('k1', true);
    const report = screen.getByRole('checkbox', { name: /Build speed\?/ });
    expect(report).toBeChecked();
    fireEvent.click(report);
    expect(p.onToggleReport).toHaveBeenCalledWith('run-1', false);
    expect(screen.getByText('4 documents')).toBeInTheDocument();
    expect(screen.getByText('12 facts · 5 sources')).toBeInTheDocument();
  });

  it('disables web search with the reason, even when the draft has it on', () => {
    render(<DraftSourcesPanel {...props({ webSearch: true, webDisabledReason: 'Turn on web search in Settings' })} />);
    const web = screen.getByRole('checkbox', { name: 'Web search' });
    expect(web).toBeDisabled();
    expect(web).not.toBeChecked();
    expect(web).toHaveAccessibleDescription('Turn on web search in Settings');
  });

  it('says when there is nothing to pick, and while the lists load', () => {
    const { rerender } = render(<DraftSourcesPanel {...props({ collections: [], reports: [] })} />);
    expect(screen.getByText(/No document collections yet/)).toBeInTheDocument();
    expect(screen.getByText(/No finished Research reports yet/)).toBeInTheDocument();
    rerender(<DraftSourcesPanel {...props({ collections: null, reports: null })} />);
    expect(screen.getAllByText('Loading…')).toHaveLength(2);
  });
});

describe('draft web search availability', () => {
  const ready = { localOnly: false, webSearchEnabled: true, webSearchConsentAcknowledged: true };

  it('follows the chat web search gates', () => {
    expect(draftWebSearchUnavailableReasonId(ready)).toBeNull();
    expect(draftWebSearchUnavailableReasonId({ ...ready, localOnly: true })).toBe('writing.sources.web.unavailableLocalOnly');
    expect(draftWebSearchUnavailableReasonId({ ...ready, webSearchEnabled: false })).toBe('writing.sources.web.unavailableSearchOff');
    expect(draftWebSearchUnavailableReasonId({ ...ready, webSearchConsentAcknowledged: false })).toBe(
      'writing.sources.web.unavailableNoConsent',
    );
  });

  it('is on only when the draft asks for it and the settings allow it', () => {
    const on = { sources: { webSearch: true, researchRunIds: [] } };
    expect(draftWebSearchActive(on, ready)).toBe(true);
    expect(draftWebSearchActive(on, { ...ready, localOnly: true })).toBe(false);
    expect(draftWebSearchActive({ sources: { webSearch: false, researchRunIds: [] } }, ready)).toBe(false);
    // A draft read from a backend without sources yet.
    expect(draftWebSearchActive({} as never, ready)).toBe(false);
  });
});
