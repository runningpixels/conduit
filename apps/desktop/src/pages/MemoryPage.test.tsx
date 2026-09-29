import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppSettings, MemoryItem } from '../ipc/contracts';
import { MemoryPage } from './MemoryPage';

const ipc = vi.hoisted(() => ({
  listMemoryItems: vi.fn(),
  createMemoryItem: vi.fn(),
  updateMemoryItem: vi.fn(),
  deleteMemoryItem: vi.fn(),
  acceptMemoryItem: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../ipc/client', () => ipc);

const settings = { memoryEnabled: true } as AppSettings;

function item(overrides: Partial<MemoryItem>): MemoryItem {
  return {
    id: 'm1',
    kind: 'core',
    body: 'I prefer terse commit messages',
    pinned: false,
    status: 'active',
    createdAt: '2026-09-04T00:00:00Z',
    updatedAt: '2026-09-04T00:00:00Z',
    ...overrides,
  };
}

function renderPage(overrides: { settings?: AppSettings; onSettingsChange?: () => void; onStatus?: () => void } = {}) {
  return render(
    <MemoryPage
      settings={overrides.settings ?? settings}
      onSettingsChange={overrides.onSettingsChange ?? vi.fn()}
      onStatus={overrides.onStatus ?? vi.fn()}
    />,
  );
}

describe('MemoryPage', () => {
  beforeEach(() => {
    for (const fn of Object.values(ipc)) fn.mockReset();
    ipc.listMemoryItems.mockResolvedValue([]);
    ipc.createMemoryItem.mockResolvedValue(item({}));
    ipc.updateMemoryItem.mockResolvedValue(item({}));
    ipc.deleteMemoryItem.mockResolvedValue(undefined);
    ipc.acceptMemoryItem.mockResolvedValue(item({}));
    ipc.updateSettings.mockImplementation(async (s: AppSettings) => s);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the empty state and adds a memory from it', async () => {
    const onStatus = vi.fn();
    // Empty until the fact is saved, however many times the page reloads.
    ipc.listMemoryItems.mockImplementation(async () =>
      ipc.createMemoryItem.mock.calls.length > 0 ? [item({ kind: 'note' })] : [],
    );
    renderPage({ onStatus });
    const empty = (await screen.findByText('Nothing remembered yet')).closest('.page-empty') as HTMLElement;
    fireEvent.click(within(empty).getByRole('button', { name: 'Add memory' }));
    const box = screen.getByRole('textbox', { name: 'New memory' });
    expect(screen.getByRole('button', { name: 'Save fact' })).toBeDisabled();
    fireEvent.change(box, { target: { value: '  I prefer terse commit messages ' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Memory kind' }), { target: { value: 'note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save fact' }));
    await waitFor(() => expect(ipc.createMemoryItem).toHaveBeenCalledWith('I prefer terse commit messages', 'note'));
    // Look for the saved fact in the Notes list, not anywhere on the page:
    // until the save lands, the same text is still in the composer's textarea
    // (which getByText matches), and the composer closing detaches it. Save →
    // reload → render is three async hops; a loaded CI runner needs more than
    // findBy's default second.
    const notes = await screen.findByRole('region', { name: 'Notes' }, { timeout: 5000 });
    expect(within(notes).getByText('I prefer terse commit messages')).toBeInTheDocument();
    expect(onStatus).toHaveBeenCalledWith('Saved memory');
    expect(screen.queryByRole('textbox', { name: 'New memory' })).not.toBeInTheDocument();
  });

  it('toggles memory from the header switch and says when it is off', async () => {
    const onSettingsChange = vi.fn();
    const { rerender } = renderPage({ onSettingsChange });
    await screen.findByText('Nothing remembered yet');
    fireEvent.click(screen.getByRole('switch', { name: 'Use saved memory' }));
    expect(onSettingsChange).toHaveBeenCalledWith({ ...settings, memoryEnabled: false });
    rerender(<MemoryPage settings={{ ...settings, memoryEnabled: false }} onSettingsChange={onSettingsChange} onStatus={vi.fn()} />);
    expect(screen.getByText(/Memory is off/)).toBeInTheDocument();
  });

  it('puts suggestions first and accepts or discards them', async () => {
    ipc.listMemoryItems.mockResolvedValue([
      item({}),
      item({ id: 'p1', status: 'pending', body: 'Queued BANANA-MEMORY', sourceConversationId: 'c1' }),
      item({ id: 'p2', status: 'pending', body: 'Another suggestion' }),
    ]);
    renderPage();
    const pending = await screen.findByRole('region', { name: 'Waiting for you' });
    expect(within(pending).getByText('Queued BANANA-MEMORY')).toBeInTheDocument();
    expect(within(pending).getAllByText(/from a chat/)).toHaveLength(1);
    // The suggestion block precedes the saved facts in the document.
    const core = screen.getByRole('region', { name: 'Core' });
    expect(pending.compareDocumentPosition(core) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(within(pending).getAllByRole('button', { name: 'Save' })[0]);
    await waitFor(() => expect(ipc.acceptMemoryItem).toHaveBeenCalledWith('p1'));
    // Saving reloads the list, so find the second suggestion's row afresh
    // rather than through the element found before (it may be gone).
    const second = (await screen.findByText('Another suggestion')).closest('li') as HTMLElement;
    fireEvent.click(within(second).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(ipc.deleteMemoryItem).toHaveBeenCalledWith('p2'));
  });

  it('edits a fact inline, including its kind', async () => {
    ipc.listMemoryItems.mockResolvedValue([item({ pinned: true })]);
    renderPage();
    await screen.findByText('I prefer terse commit messages');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Edit memory' });
    fireEvent.change(box, { target: { value: 'Short commit messages' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Memory kind' }), { target: { value: 'note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ipc.updateMemoryItem).toHaveBeenCalledWith('m1', 'Short commit messages', 'note', true));
  });

  it('pins, and deletes only after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    ipc.listMemoryItems.mockResolvedValue([item({})]);
    renderPage();
    await screen.findByText('I prefer terse commit messages');
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() =>
      expect(ipc.updateMemoryItem).toHaveBeenCalledWith('m1', 'I prefer terse commit messages', 'core', true),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled(), { timeout: 5000 });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(ipc.deleteMemoryItem).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(ipc.deleteMemoryItem).toHaveBeenCalledWith('m1'));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });

  it('reports a failed action', async () => {
    const onStatus = vi.fn();
    ipc.listMemoryItems.mockResolvedValue([item({ status: 'pending' })]);
    ipc.acceptMemoryItem.mockRejectedValue(new Error('boom'));
    renderPage({ onStatus });
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('boom')));
  });
});
