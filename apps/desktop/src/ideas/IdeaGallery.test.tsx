import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { GALLERY_SIZE, IdeaGallery, galleryIdeas } from './IdeaGallery';
import { resolveCapabilities } from './capabilities';
import { IDEAS } from './catalog';
import { __resetIdeaStateForTests, getIdeaState } from './ideaState';
import { ideaStatus } from './selectIdeas';

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

beforeEach(() => __resetIdeaStateForTests());

describe('galleryIdeas', () => {
  it('shows at most a full grid of ready ideas', () => {
    const c = caps();
    const all = galleryIdeas('all', c, getIdeaState());
    expect(all.length).toBeGreaterThan(0);
    expect(all.length).toBeLessThanOrEqual(GALLERY_SIZE);
    for (const idea of all) expect(ideaStatus(idea, c)).toBe('ready');
  });

  it('filters to one category, ready ideas only', () => {
    const c = caps({ webSearchEnabled: false, artifactNetworkEnabled: false });
    const live = galleryIdeas('live', c, getIdeaState());
    for (const idea of live) {
      expect(idea.category).toBe('live');
      expect(ideaStatus(idea, c)).toBe('ready');
    }
  });
});

describe('IdeaGallery', () => {
  it('picks an idea, switches category, and offers more and hide', () => {
    const onPick = vi.fn();
    const onMore = vi.fn();
    const onHide = vi.fn();
    render(<IdeaGallery caps={caps()} state={getIdeaState()} onPick={onPick} onMore={onMore} onHide={onHide} />);

    const all = screen.getByRole('button', { name: 'All', pressed: true });
    expect(all).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Play', pressed: false }));
    expect(screen.getByRole('button', { name: 'Play', pressed: true })).toBeTruthy();

    const grid = screen.getByRole('list');
    const cards = within(grid).getAllByRole('button');
    const playIds = IDEAS.filter((i) => i.category === 'play').map((i) => i.id);
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expect(card.getAttribute('data-category')).toBe('play');

    fireEvent.click(cards[0]);
    expect(playIds).toContain(onPick.mock.calls[0][0].id);

    fireEvent.click(screen.getByRole('button', { name: /More ideas/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide ideas in new chats' }));
    expect(onMore).toHaveBeenCalled();
    expect(onHide).toHaveBeenCalled();
  });
});
