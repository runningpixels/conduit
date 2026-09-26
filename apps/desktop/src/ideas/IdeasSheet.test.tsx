import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../ipc/client', () => ({
  createPrompt: vi.fn(),
  deletePrompt: vi.fn(),
  listPromptFolders: vi.fn(async () => []),
  listPrompts: vi.fn(async () => []),
  updatePrompt: vi.fn(),
}));

import { IdeasSheet } from './IdeasSheet';
import { IdeaStarterRow } from './IdeaStarterRow';
import { resolveCapabilities } from './capabilities';
import { IDEAS, IDEAS_REVISION } from './catalog';
import { __resetIdeaStateForTests, getIdeaState, notePicked, noteFirstMessage, updateIdeaState } from './ideaState';

const caps = (over: Record<string, unknown> = {}) =>
  resolveCapabilities({
    settings: {
      localOnly: false,
      activeProvider: 'anthropic',
      artifactNetworkEnabled: true,
      webSearchEnabled: true,
      workspaceToolsEnabled: false,
      workspaceToolsConsentAcknowledged: false,
      ...over,
    },
    provider: { isLocal: false },
    collectionCount: 0,
  });

function sheet(props: Partial<Parameters<typeof IdeasSheet>[0]> = {}) {
  const onTry = vi.fn();
  const onSetup = vi.fn();
  const onClose = vi.fn();
  render(
    <IdeasSheet
      open
      onClose={onClose}
      caps={caps()}
      onTry={onTry}
      onSetup={onSetup}
      onInsertPrompt={() => {}}
      onStatus={() => {}}
      {...props}
    />,
  );
  return { onTry, onSetup, onClose };
}

beforeEach(() => __resetIdeaStateForTests());

describe('IdeasSheet', () => {
  it('lists ideas with Try, and starts the one picked', () => {
    const { onTry } = sheet();
    fireEvent.click(screen.getAllByRole('button', { name: 'Try Snake' })[0]);
    expect(onTry).toHaveBeenCalledWith(expect.objectContaining({ id: 'snakeGame' }));
  });

  it('routes an idea that needs setup to the place that sets it up', () => {
    const { onSetup } = sheet();
    // Anthropic has no image endpoint: image ideas ask for a provider.
    fireEvent.click(screen.getByRole('button', { name: 'Images' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add an image provider' })[0]);
    expect(onSetup).toHaveBeenCalledWith('providers');
  });

  it('hides what this setup cannot run until asked', () => {
    sheet({ caps: caps({ localOnly: true, activeProvider: 'ollama' }) });
    expect(screen.queryByRole('button', { name: 'Try Weather dashboard' })).toBeNull();
    const liveCount = IDEAS.filter((i) => i.needs.some((n) => ['network', 'webSearch', 'imageGen'].includes(n))).length;
    fireEvent.click(screen.getByLabelText(`Show ${liveCount} ideas this setup can't run`));
    expect(screen.getAllByText('Weather dashboard').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not available with this setup').length).toBe(liveCount);
  });

  it('filters by category and search', () => {
    sheet();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    const all = screen.getByRole('region', { name: 'All ideas' });
    expect(within(all).getAllByRole('article')).toHaveLength(IDEAS.filter((i) => i.category === 'play').length);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'currency' } });
    expect(within(all).getAllByRole('article')).toHaveLength(1);
  });

  it('marks tried ideas, and turns the new-chat row on and off', () => {
    notePicked('snakeGame');
    noteFirstMessage();
    sheet();
    expect(screen.getAllByText('✓ Tried').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText('Show ideas in new chats'));
    expect(getIdeaState().rowHidden).toBe(true);
  });

  it('shows the spotlight, and marks it and the revision seen on close', () => {
    updateIdeaState((s) => ({ ...s, spotlight: ['webSearch'], seenRevision: 0 }));
    const onClose = vi.fn();
    const { rerender } = render(
      <IdeasSheet open onClose={onClose} caps={caps()} onTry={() => {}} onSetup={() => {}} onInsertPrompt={() => {}} onStatus={() => {}} />,
    );
    expect(screen.getByRole('region', { name: 'Now you can' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'New in this version' })).toBeTruthy();
    rerender(
      <IdeasSheet open={false} onClose={onClose} caps={caps()} onTry={() => {}} onSetup={() => {}} onInsertPrompt={() => {}} onStatus={() => {}} />,
    );
    expect(getIdeaState().spotlight).toEqual([]);
    expect(getIdeaState().seenRevision).toBe(IDEAS_REVISION);
  });

  it('shows saved prompts under My prompts', async () => {
    sheet();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'My prompts' }));
    });
    expect(screen.getByText('Prompts you saved. Insert one into the chat, or save a new one.')).toBeTruthy();
  });
});

describe('IdeaStarterRow', () => {
  it('offers ideas, more ideas, and a way to hide the row', () => {
    const onPick = vi.fn();
    const onMore = vi.fn();
    const onHide = vi.fn();
    render(<IdeaStarterRow ideas={IDEAS.slice(0, 3)} onPick={onPick} onMore={onMore} onHide={onHide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pomodoro timer' }));
    fireEvent.click(screen.getByRole('button', { name: 'More ideas' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide ideas in new chats' }));
    expect(onPick).toHaveBeenCalledWith(IDEAS[0]);
    expect(onMore).toHaveBeenCalled();
    expect(onHide).toHaveBeenCalled();
  });
});
