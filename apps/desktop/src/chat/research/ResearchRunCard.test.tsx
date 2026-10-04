import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ResearchBrief, ResearchRun } from '../../ipc/contracts';

vi.mock('../../ipc/client', () => ({
  getResearchRun: vi.fn(),
  approveResearchBrief: vi.fn(),
  stopResearch: vi.fn(),
  cancelResearch: vi.fn(),
  openExternalUrl: vi.fn(),
}));

// The card listens to the app-wide `research-run-updated` event; capture the
// handler so a test can deliver one.
const listeners: Array<(event: { payload: unknown }) => void> = [];
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    listeners.push(handler);
    return () => {
      const at = listeners.indexOf(handler);
      if (at >= 0) listeners.splice(at, 1);
    };
  }),
}));

import {
  approveResearchBrief,
  cancelResearch,
  getResearchRun,
  openExternalUrl,
  stopResearch,
} from '../../ipc/client';
import { ResearchRunCard } from './ResearchRunCard';

const brief: ResearchBrief = {
  question: 'How do heat pumps cope with cold winters?',
  subQuestions: ['What is their efficiency below -10 C?', 'What do they cost to run?'],
  scope: null,
  preferDomains: ['energy.gov'],
  avoidDomains: [],
  depth: 'standard',
};

function run(over: Partial<ResearchRun> = {}): ResearchRun {
  return {
    id: 'run-1',
    conversationId: 'conv-1',
    messageId: 'msg-2',
    status: 'planning',
    brief: null,
    budget: { searches: 20, pages: 40, tokens: 400_000, minutes: 20 },
    progress: {
      phase: 'searching',
      searchesUsed: 0,
      searchesLimit: 20,
      pagesRead: 0,
      pagesLimit: 40,
      claims: 0,
      currentUrl: null,
      tokensUsed: 0,
    },
    artifactId: null,
    summary: null,
    sources: [],
    unanswered: [],
    unverifiedDropped: 0,
    error: null,
    createdAt: '2026-10-03T10:00:00Z',
    finishedAt: null,
    ...over,
  };
}

function renderCard(onOpenArtifact = vi.fn()) {
  render(<ResearchRunCard runId="run-1" onOpenArtifact={onOpenArtifact} />);
  return { onOpenArtifact };
}

/** Deliver `research-run-updated` the way Rust does. */
async function emit(runId: string, status: string) {
  await act(async () => {
    for (const handler of [...listeners]) handler({ payload: { runId, status } });
  });
}

describe('ResearchRunCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.length = 0;
  });

  it('shows a spinner and "Planning the research…" while planning', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(run());
    renderCard();
    expect(await screen.findByText('Planning the research…')).toBeInTheDocument();
    expect(getResearchRun).toHaveBeenCalledWith('run-1');
  });

  it('shows the brief when planning ends: question read-only, sub-questions editable, depth with estimates', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(run({ status: 'awaitingApproval', brief }));
    renderCard();
    const form = await screen.findByRole('form', { name: 'Research brief' });
    expect(within(form).getByText(brief.question)).toBeInTheDocument();
    // Read-only: the question is text, not a field.
    expect(within(form).queryByDisplayValue(brief.question)).toBeNull();
    expect(within(form).getByLabelText('Sub-question 1')).toHaveValue(brief.subQuestions[0]);
    expect(within(form).getByLabelText('Sub-question 2')).toHaveValue(brief.subQuestions[1]);
    expect(within(form).getByRole('radio', { name: /Standard/ })).toBeChecked();
    expect(within(form).getByText('Up to 8 searches, 15 pages, about 10 min')).toBeInTheDocument();
    expect(within(form).getByText('Up to 20 searches, 40 pages, about 20 min')).toBeInTheDocument();
    expect(within(form).getByText('Up to 50 searches, 100 pages, about 40 min')).toBeInTheDocument();
  });

  it('starts with the edited brief', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(run({ status: 'awaitingApproval', brief }));
    vi.mocked(approveResearchBrief).mockResolvedValue(
      run({ status: 'running', brief: { ...brief, depth: 'deep' } }),
    );
    renderCard();
    await screen.findByRole('form', { name: 'Research brief' });

    fireEvent.change(screen.getByLabelText('Sub-question 1'), { target: { value: 'What changed in 2025?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove sub-question 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a sub-question' }));
    fireEvent.change(screen.getByLabelText('Sub-question 2'), { target: { value: '  Which models work best?  ' } });
    fireEvent.change(screen.getByLabelText('Scope (optional)'), { target: { value: ' Europe, 2025 ' } });
    fireEvent.click(screen.getByRole('radio', { name: /Deep/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start research' }));

    await waitFor(() => expect(approveResearchBrief).toHaveBeenCalledTimes(1));
    expect(approveResearchBrief).toHaveBeenCalledWith('run-1', {
      ...brief,
      subQuestions: ['What changed in 2025?', 'Which models work best?'],
      scope: 'Europe, 2025',
      depth: 'deep',
    });
    // The reply is the new state: the card moves on without waiting for an event.
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument();
  });

  it('keeps between one and six sub-questions', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(
      run({ status: 'awaitingApproval', brief: { ...brief, subQuestions: ['only one'] } }),
    );
    renderCard();
    await screen.findByRole('form', { name: 'Research brief' });
    // The last one cannot be removed.
    expect(screen.getByRole('button', { name: 'Remove sub-question 1' })).toBeDisabled();
    const add = screen.getByRole('button', { name: 'Add a sub-question' });
    for (let i = 0; i < 5; i += 1) fireEvent.click(add);
    expect(screen.getAllByLabelText(/^Sub-question \d$/)).toHaveLength(6);
    expect(add).toBeDisabled();
    // Blank rows do not count: with every row empty there is nothing to start.
    fireEvent.change(screen.getByLabelText('Sub-question 1'), { target: { value: '' } });
    for (let i = 2; i <= 6; i += 1) {
      expect(screen.getByLabelText(`Sub-question ${i}`)).toHaveValue('');
    }
    expect(screen.getByRole('button', { name: 'Start research' })).toBeDisabled();
  });

  it('shows the error and stays on the brief when Start fails', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(run({ status: 'awaitingApproval', brief }));
    vi.mocked(approveResearchBrief).mockRejectedValue(new Error('Web search is off'));
    renderCard();
    await screen.findByRole('form', { name: 'Research brief' });
    fireEvent.click(screen.getByRole('button', { name: 'Start research' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Web search is off');
    expect(screen.getByRole('button', { name: 'Start research' })).toBeEnabled();
  });

  it('cancels a brief that has not been approved', async () => {
    vi.mocked(getResearchRun)
      .mockResolvedValueOnce(run({ status: 'awaitingApproval', brief }))
      .mockResolvedValue(run({ status: 'stopped', brief }));
    vi.mocked(cancelResearch).mockResolvedValue(undefined);
    renderCard();
    await screen.findByRole('form', { name: 'Research brief' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(cancelResearch).toHaveBeenCalledWith('run-1'));
    expect(await screen.findByText('Research stopped.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Research brief' })).toBeNull();
  });

  it('shows live progress while running and stops on request', async () => {
    const running = run({
      status: 'running',
      brief,
      progress: {
        phase: 'reading',
        searchesUsed: 4,
        searchesLimit: 20,
        pagesRead: 9,
        pagesLimit: 40,
        claims: 12,
        currentUrl: 'https://www.energy.gov/some/page?x=1',
        tokensUsed: 1000,
      },
    });
    vi.mocked(getResearchRun).mockResolvedValue(running);
    vi.mocked(stopResearch).mockResolvedValue(undefined);
    renderCard();
    expect(await screen.findByText('Reading pages…')).toBeInTheDocument();
    expect(screen.getByText('4 of 20')).toBeInTheDocument();
    expect(screen.getByText('9 of 40')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Reading www.energy.gov')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(stopResearch).toHaveBeenCalledWith('run-1'));
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  });

  it('refetches the run when research-run-updated arrives for it, and ignores other runs', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(run());
    renderCard();
    await screen.findByText('Planning the research…');
    await waitFor(() => expect(listeners).toHaveLength(1));
    expect(getResearchRun).toHaveBeenCalledTimes(1);

    await emit('some-other-run', 'running');
    expect(getResearchRun).toHaveBeenCalledTimes(1);

    vi.mocked(getResearchRun).mockResolvedValue(run({ status: 'awaitingApproval', brief }));
    await emit('run-1', 'awaitingApproval');
    expect(await screen.findByRole('form', { name: 'Research brief' })).toBeInTheDocument();
    expect(getResearchRun).toHaveBeenCalledTimes(2);
  });

  const done = run({
    status: 'done',
    brief,
    artifactId: 'art-9',
    summary: 'Heat pumps work down to **-25 C** with modern compressors [1].',
    sources: [
      {
        id: 's1',
        url: 'https://www.energy.gov/heat-pumps',
        title: 'Heat pumps',
        host: 'www.energy.gov',
        fetchedAt: '2026-10-03T10:05:00Z',
        status: 'read',
        claims: 3,
        footnote: 1,
      },
      {
        id: 's2',
        url: 'https://example.org/blocked',
        title: null,
        host: 'example.org',
        fetchedAt: '2026-10-03T10:06:00Z',
        status: 'failed',
        claims: 0,
        footnote: null,
      },
    ],
    unanswered: ['What do they cost to run?'],
    unverifiedDropped: 2,
    finishedAt: '2026-10-03T10:09:00Z',
  });

  it('renders the summary, notes, and a collapsible source list when done', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(done);
    renderCard();
    const strong = await screen.findByText('-25 C');
    expect(strong.tagName).toBe('STRONG');
    // Citations are the report's plain [n] numbers, never footnote syntax.
    const summary = strong.closest('.research-summary')!;
    expect(summary.textContent).toContain('compressors [1].');
    expect(summary.textContent).not.toContain('[^');
    expect(screen.getByText('2 claims were left out because their quotes could not be found in their sources.')).toBeInTheDocument();
    expect(screen.getByText('Not answered')).toBeInTheDocument();
    expect(screen.getByText('What do they cost to run?')).toBeInTheDocument();

    const details = screen.getByText('1 cited · 1 read').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText('Heat pumps')).toBeInTheDocument();
    expect(within(details).getByText('[1]')).toBeInTheDocument();
    // No title: the host stands in for it.
    expect(within(details).getAllByText('example.org')).not.toHaveLength(0);
    expect(within(details).getByText('Read')).toBeInTheDocument();
    expect(within(details).getByText('Failed')).toBeInTheDocument();
  });

  it('says nothing about dropped claims or open questions when there are none', async () => {
    vi.mocked(getResearchRun).mockResolvedValue({ ...done, unanswered: [], unverifiedDropped: 0 });
    renderCard();
    await screen.findByText('-25 C');
    expect(screen.queryByText('Not answered')).toBeNull();
    expect(screen.queryByText(/were left out|was left out/)).toBeNull();
  });

  it('opens the report through the artifact path', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(done);
    const { onOpenArtifact } = renderCard();
    fireEvent.click(await screen.findByRole('button', { name: 'Open report' }));
    expect(onOpenArtifact).toHaveBeenCalledWith('art-9');
  });

  it('offers "Write from this report" on a finished run only', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(done);
    const onWriteFromReport = vi.fn();
    const { unmount } = render(
      <ResearchRunCard runId="run-1" onOpenArtifact={vi.fn()} onWriteFromReport={onWriteFromReport} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Write from this report' }));
    expect(onWriteFromReport).toHaveBeenCalledWith('run-1', brief.question);
    unmount();

    vi.mocked(getResearchRun).mockResolvedValue({ ...done, status: 'stopped' });
    render(<ResearchRunCard runId="run-1" onOpenArtifact={vi.fn()} onWriteFromReport={onWriteFromReport} />);
    await screen.findByRole('button', { name: 'Open report' });
    expect(screen.queryByRole('button', { name: 'Write from this report' })).toBeNull();
  });

  it('has no "Write from this report" where drafts cannot start', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(done);
    renderCard();
    await screen.findByRole('button', { name: 'Open report' });
    expect(screen.queryByRole('button', { name: 'Write from this report' })).toBeNull();
  });

  it('opens a source in the browser, not in the app', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(done);
    vi.mocked(openExternalUrl).mockResolvedValue(undefined);
    renderCard();
    await screen.findByText('-25 C');
    fireEvent.click(screen.getByText('1 cited · 1 read'));
    fireEvent.click(screen.getByRole('link', { name: /Heat pumps/ }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://www.energy.gov/heat-pumps');
  });

  it('shows the error and the partial report when a run failed', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(
      run({ status: 'failed', brief, error: 'The model stopped answering.', artifactId: 'art-3' }),
    );
    const { onOpenArtifact } = renderCard();
    expect(await screen.findByText('Research failed.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The model stopped answering.');
    fireEvent.click(screen.getByRole('button', { name: 'Open report' }));
    expect(onOpenArtifact).toHaveBeenCalledWith('art-3');
  });

  it('offers no report button when a stopped run wrote none', async () => {
    vi.mocked(getResearchRun).mockResolvedValue(run({ status: 'stopped', brief }));
    renderCard();
    expect(await screen.findByText('Research stopped.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open report' })).toBeNull();
  });

  it('says so and offers Retry when the run cannot be read', async () => {
    vi.mocked(getResearchRun).mockRejectedValueOnce(new Error('Run not found')).mockResolvedValue(run());
    renderCard();
    expect(await screen.findByRole('alert')).toHaveTextContent('Run not found');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Planning the research…')).toBeInTheDocument();
  });
});
