import { describe, expect, it } from 'vitest';
import type { DeckDetail } from '../ipc/contracts';
import { deckDeveloperPrompt, deckSystemAppendix } from './deckPrompt';

const deck: DeckDetail = {
  id: 'd1',
  title: 'Q3 review',
  themeName: 'ink',
  themeCss: '',
  assumptions: '',
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
  it('outlines each slide with its text, pinned slots and layout problems', () => {
    const prompt = deckDeveloperPrompt(deck, { s2: 'too much content: cut it down.' });
    expect(prompt).toContain('1. s1 · stat-row · Builds got 3× faster −45% [pinned: stat-2]');
    expect(prompt).toContain('2. s2 · bullets · Next [layout check: too much content: cut it down.]');
    expect(prompt).toContain('1. Builds got faster');
  });

  it('says nothing about pinning or layout when there is none', () => {
    const prompt = deckDeveloperPrompt({ ...deck, slides: [deck.slides[1]] });
    expect(prompt).not.toContain('pinned');
    expect(prompt).not.toContain('layout check');
  });
});

describe('deckSystemAppendix', () => {
  const text = deckSystemAppendix();

  it('teaches the deck-wide tools and pinned text', () => {
    expect(text).toContain('replace_in_deck');
    expect(text).toContain('update_slots');
    expect(text).toContain('release_pinned');
  });

  it('teaches typed slides: a word change is update_slots, a restructure is update_slide with fields', () => {
    expect(text).toContain('For a word change, use update_slots');
    expect(text).toContain('To restructure a slide, use update_slide with its slide_id and only the fields that change');
    expect(text).toContain('patch_slide is only for custom slides');
    expect(text).toContain("add_slide takes a layout and that layout's fields");
  });

  it('lists every layout with its fields and limits, as the slide tools validate them', () => {
    for (const line of [
      '- title: headline (≤ 10 words), sub (≤ 20), optional kicker (≤ 4).',
      '- statement: one big headline (≤ 14 words), optional sub (≤ 20).',
      '- bullets: headline (≤ 10 words), bullets: 2-5 items of ≤ 14 words; optional kicker.',
      '- stat-row: stats: 2-4 {value, label}; value ≤ 6 characters',
      '- two-col: headline (≤ 10 words), columns: exactly 2 {kicker (≤ 4 words), then body (≤ 30 words) or bullets (2-4 items of ≤ 10 words)}',
      '- quote: quote (≤ 30 words), cite (≤ 8 words).',
      '- section: headline (≤ 8 words), optional kicker (≤ 4',
      '- image-left: headline (≤ 10 words), body (≤ 30 words) or bullets (2-3 items of ≤ 12 words), and exactly one of chart or svg',
      '- chart: headline (≤ 12 words) and exactly one of chart or svg',
      '- custom: html only',
    ]) {
      expect(text).toContain(line);
    }
    expect(text).toContain('footnote, a source or note of ≤ 20 words, fits every layout except title, section and custom.');
  });

  it('gives a bar and a funnel chart example that parse, and the svg rules', () => {
    const examples = [...text.matchAll(/^- (?:bar|funnel): (\{.*\})\. /gm)].map((m) => JSON.parse(m[1]));
    expect(examples.map((e) => e.type)).toEqual(['bar', 'funnel']);
    expect(examples[0].series[0].values).toHaveLength(examples[0].categories.length);
    expect(text).toContain('exactly one <svg> element with a viewBox');
    expect(text).toContain('no width, height or style on it');
    expect(text).toContain('font-size 24 or more');
  });

  it('keeps custom for when no layout fits, and says it gets a layout check', () => {
    expect(text).toContain('only when no layout fits; custom slides get a layout check');
    expect(text).toContain('data-text');
    expect(text).toContain('"Layout check" message: fix only what it lists');
  });

  it('stays compact: a local model reads it every turn', () => {
    expect(text.length).toBeLessThan(6500);
  });
});
