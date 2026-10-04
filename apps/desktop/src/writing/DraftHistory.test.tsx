import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DraftSnapshotSummary } from '../ipc/contracts';
import { DraftHistory } from './DraftHistory';
import { DraftDock } from './DraftDock';

const SNAPSHOTS: DraftSnapshotSummary[] = [
  { id: 's3', cause: 'ai-turn', label: 'Make “Intro” shorter', words: 900, createdAt: '2026-10-01T12:00:00Z' },
  { id: 's2', cause: 'manual', label: 'Edited by you', words: 950, createdAt: '2026-10-01T11:00:00Z' },
  { id: 's1', cause: 'created', label: null, words: 0, createdAt: '2026-10-01T10:00:00Z' },
];

describe('DraftHistory', () => {
  it('lists versions newest first, labelled by prompt or cause', async () => {
    render(<DraftHistory revision={0} onList={vi.fn().mockResolvedValue(SNAPSHOTS)} onRestore={vi.fn()} />);
    expect(await screen.findByText('Make “Intro” shorter')).toBeInTheDocument();
    expect(screen.getByText('Edited by you')).toBeInTheDocument();
    expect(screen.getByText('Draft created')).toBeInTheDocument();
    expect(screen.getByText('Latest')).toBeInTheDocument();
    expect(screen.getByText(/900 words/)).toBeInTheDocument();
  });

  it('restores a version after an inline confirmation', async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(<DraftHistory revision={0} onList={vi.fn().mockResolvedValue(SNAPSHOTS)} onRestore={onRestore} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore “Edited by you”' }));
    const confirm = screen.getByRole('group', { name: 'Replace the current draft with this version?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith('s2'));
  });

  it('reloads when the revision bumps', async () => {
    const onList = vi.fn().mockResolvedValue([]);
    const { rerender } = render(<DraftHistory revision={0} onList={onList} onRestore={vi.fn()} />);
    expect(await screen.findByText(/No saved versions yet/)).toBeInTheDocument();
    rerender(<DraftHistory revision={1} onList={onList} onRestore={vi.fn()} />);
    await waitFor(() => expect(onList).toHaveBeenCalledTimes(2));
  });
});

describe('DraftDock', () => {
  it('has Ask, Outline and History in the draft stage, and moves with the arrow keys', () => {
    const onTab = vi.fn();
    render(
      <DraftDock tab="ask" onTab={onTab} showOutline outline={<p>outline</p>} history={<p>history</p>}>
        {null}
      </DraftDock>,
    );
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Ask', 'Outline', 'History']);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Ask' }), { key: 'ArrowRight' });
    expect(onTab).toHaveBeenCalledWith('outline');
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(onTab).toHaveBeenCalledWith('history');
  });

  it('leaves Outline out while the outline is the main view', () => {
    render(
      <DraftDock tab="ask" onTab={vi.fn()} showOutline={false} outline={<p>outline</p>} history={<p>history</p>}>
        {null}
      </DraftDock>,
    );
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Ask', 'History']);
    expect(screen.queryByText('outline')).toBeNull();
  });
});
