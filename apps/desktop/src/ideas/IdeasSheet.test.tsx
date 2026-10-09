import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../ipc/client', () => ({
  createPrompt: vi.fn(),
  deletePrompt: vi.fn(),
  listPromptFolders: vi.fn(async () => []),
  listPrompts: vi.fn(async () => []),
  openExternalUrl: vi.fn(async () => {}),
  updatePrompt: vi.fn(),
}));

import { openExternalUrl } from '../ipc/client';
import { IdeasSheet } from './IdeasSheet';
import { FREE_APIS } from './freeApis';
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

  it('lists the free APIs, opens their docs, and starts the idea built on one', () => {
    const { onTry, onSetup } = sheet();
    fireEvent.click(screen.getByRole('tab', { name: 'Free APIs' }));
    const list = screen.getByRole('region', { name: 'Free APIs' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(FREE_APIS.length);
    expect(within(list).getByText('Open-Meteo')).toBeTruthy();
    expect(within(list).getByText('Recent earthquakes worldwide')).toBeTruthy();
    expect(within(list).getAllByText('60 requests an hour').length).toBeGreaterThan(0);

    fireEvent.click(within(list).getByRole('button', { name: 'Open the USGS Earthquakes docs' }));
    expect(openExternalUrl).toHaveBeenCalledWith('https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php');

    fireEvent.click(within(list).getByRole('button', { name: 'Try Earthquake tracker, built on USGS Earthquakes' }));
    expect(onTry).toHaveBeenCalledWith(expect.objectContaining({ id: 'earthquakeTracker' }));
    expect(onSetup).not.toHaveBeenCalled();
  });

  it('asks to let pages connect before a free API idea can run', () => {
    const { onTry, onSetup } = sheet({ caps: caps({ artifactNetworkEnabled: false }) });
    fireEvent.click(screen.getByRole('tab', { name: 'Free APIs' }));
    const row = screen.getByText('Frankfurter').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Let pages connect' }));
    expect(onSetup).toHaveBeenCalledWith('privacy');
    expect(onTry).not.toHaveBeenCalled();
  });

  it('shows Free APIs as a list entry on the Ideas page, and names the API on cards', () => {
    sheet({ variant: 'page' });
    expect(screen.getAllByText('Frankfurter · no key').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /^Free APIs/ }));
    expect(screen.getByRole('region', { name: 'Free APIs' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Play/ }));
    expect(screen.queryByRole('region', { name: 'Free APIs' })).toBeNull();
  });

  it('shows saved prompts under My prompts', async () => {
    sheet();
    await act(async () => {
      fireEvent.click(screen.getByRole('tab', { name: 'My prompts' }));
    });
    expect(screen.getByText('Prompts you saved. Insert one into the chat, or save a new one.')).toBeTruthy();
  });
});
