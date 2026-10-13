import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowRun, WorkflowRunOutput } from '../ipc/contracts';
import { ResultView } from './ResultView';

const ipc = vi.hoisted(() => ({ getArtifact: vi.fn(), openExternalUrl: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

const doc: WorkflowRunOutput = {
  kind: 'document',
  title: 'Morning briefing',
  stepId: 'save',
  artifactId: 'a1',
  conversationId: 'c1',
  preview: 'Three stories today',
};

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'r1',
    workflowId: 'w1',
    version: 1,
    trigger: 'manual',
    status: 'completed',
    error: null,
    startedAt: '2026-10-11T07:00:00Z',
    finishedAt: '2026-10-11T07:01:00Z',
    outputs: [doc],
    ...over,
  };
}

beforeEach(() => {
  ipc.getArtifact.mockReset();
  ipc.getArtifact.mockResolvedValue({ id: 'a1', kind: 'markdown', contentText: '## Top story\n\nBody text' });
});

describe('ResultView', () => {
  it('shows the title and opens the document in chat', () => {
    const onOpenDocument = vi.fn();
    render(<ResultView run={run()} workflowName="Briefing" compact onOpenDocument={onOpenDocument} />);
    expect(screen.getByRole('heading', { name: 'Morning briefing' })).toBeInTheDocument();
    expect(screen.getByText('Three stories today')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open in chat' }));
    expect(onOpenDocument).toHaveBeenCalledWith('c1', 'a1');
    expect(ipc.getArtifact).not.toHaveBeenCalled();
  });

  it('reads the whole document, as Markdown, from "Open full"', async () => {
    render(<ResultView run={run()} workflowName="Briefing" compact />);
    fireEvent.click(screen.getByRole('button', { name: 'Open full' }));
    expect(await screen.findByRole('heading', { name: 'Top story' })).toBeInTheDocument();
    expect(ipc.getArtifact).toHaveBeenCalledWith('a1');
  });

  it('loads the document at once when it is not compact, and falls back to the preview', async () => {
    ipc.getArtifact.mockRejectedValue(new Error('gone'));
    render(<ResultView run={run()} workflowName="Briefing" />);
    await waitFor(() => expect(ipc.getArtifact).toHaveBeenCalled());
    expect(screen.getByText('Three stories today')).toBeInTheDocument();
  });

  it('does not inject a web page; it points to the chat', async () => {
    ipc.getArtifact.mockResolvedValue({ id: 'a1', kind: 'html', contentText: '<h1>Hi</h1>' });
    render(<ResultView run={run()} workflowName="Briefing" />);
    expect(await screen.findByText(/is a web page/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Hi' })).toBeNull();
  });

  it('lists the other outputs as buttons and opens a deck', () => {
    const onOpenDeck = vi.fn();
    const deck: WorkflowRunOutput = { kind: 'deck', title: 'Weekly numbers', stepId: 'deck', deckId: 'd1' };
    render(<ResultView run={run({ outputs: [deck, doc] })} workflowName="Briefing" compact onOpenDeck={onOpenDeck} onOpenDocument={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Weekly numbers' }));
    expect(onOpenDeck).toHaveBeenCalledWith('d1');
  });

  it('shows the path of a saved file', () => {
    const file: WorkflowRunOutput = { kind: 'file', title: 'summary.md', stepId: 'f', path: 'C:\Notes\summary.md' };
    render(<ResultView run={run({ outputs: [file] })} workflowName="Briefing" />);
    expect(screen.getByText('C:\Notes\summary.md')).toBeInTheDocument();
  });

  it('shows the error of a failed run, with run details', () => {
    const onRunDetails = vi.fn();
    render(<ResultView run={run({ status: 'failed', error: 'Timed out', outputs: [] })} workflowName="Briefing" onRunDetails={onRunDetails} />);
    expect(screen.getByRole('heading', { name: 'Failed: Briefing' })).toBeInTheDocument();
    expect(screen.getByText('Timed out')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run details' }));
    expect(onRunDetails).toHaveBeenCalled();
  });

  it('opens a link in the document in the browser, after asking', async () => {
    ipc.getArtifact.mockResolvedValue({ id: 'a1', kind: 'markdown', contentText: 'Body\n\nSource: https://example.com/page' });
    ipc.openExternalUrl.mockResolvedValue(undefined);
    render(<ResultView run={run()} workflowName="Briefing" />);
    fireEvent.click(await screen.findByRole('link', { name: 'https://example.com/page' }));
    expect(ipc.openExternalUrl).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Open link' }));
    await waitFor(() => expect(ipc.openExternalUrl).toHaveBeenCalledWith('https://example.com/page'));
  });

  it('does not call a stopped run failed', () => {
    render(<ResultView run={run({ status: 'stopped', error: 'Stopped before it finished.', outputs: [] })} workflowName="Briefing" />);
    expect(screen.queryByRole('heading', { name: 'Failed: Briefing' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Nothing was saved.' })).toBeInTheDocument();
    expect(screen.getByText('Stopped before it finished.')).toHaveClass('wf-muted');
  });
});
