import { describe, expect, it } from 'vitest';
import type { DeckDetail } from '../ipc/contracts';
import { deckDeveloperPrompt, deckSystemAppendix } from './deckPrompt';

const deck: DeckDetail = {
  id: 'd1',
  title: 'Q3 review',
  themeName: 'ink',
  themeCss: '',
  stage: 'slides',
  storyline: [{ id: 'l1', text: 'Builds got faster' }],
  slides: [
    {
      id: 's1',
      position: 0,
      layout: 'stat-row',
      html: '<h1 class="headline" data-text="headline">Builds got <span class="accent">3×</span> faster</h1><b data-text="stat-2" data-owner="user">−45%</b>',
      notes: '',
      slots: [
        { index: 0, name: 'headline', html: 'Builds got <span class="accent">3×</span> faster', text: 'Builds got 3× faster', pinned: false, tag: 'h1', classes: ['headline'] },
        { index: 1, name: 'stat-2', html: '−45%', text: '−45%', pinned: true, tag: 'b', classes: [] },
      ],
    },
    { id: 's2', position: 1, layout: 'bullets', html: '<h1 data-text="headline">Next</h1>', notes: '', slots: [] },
  ],
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
};

describe('deckDeveloperPrompt', () => {
  it('outlines each slide with its text, pinned slots and overflow', () => {
    const prompt = deckDeveloperPrompt(deck, { s2: 140 });
    expect(prompt).toContain('1. s1 · stat-row · Builds got 3× faster −45% [pinned: stat-2]');
    expect(prompt).toContain('2. s2 · bullets · Next [text overflows the slide by 140px');
    expect(prompt).toContain('1. Builds got faster');
  });

  it('says nothing about pinning or overflow when there is none', () => {
    const prompt = deckDeveloperPrompt({ ...deck, slides: [deck.slides[1]] });
    expect(prompt).not.toContain('pinned');
    expect(prompt).not.toContain('overflows');
  });
});

describe('deckSystemAppendix', () => {
  it('teaches the deck-wide tools and pinned text', () => {
    const text = deckSystemAppendix();
    expect(text).toContain('replace_in_deck');
    expect(text).toContain('update_slots');
    expect(text).toContain('release_pinned');
  });
});
