import { describe, expect, it } from 'vitest';
import type { DeckDetail, DeckSlide, SlideSlot } from '../ipc/contracts';
import { deckToMarkdown, inlineHtmlToMarkdown } from './deckMarkdown';
import { classifySlot, groupSlots } from './scriptBlocks';

let counter = 0;
const slot = (name: string, tag: string, classes: string[], html: string, pinned = false): SlideSlot => ({
  index: counter++,
  name,
  html,
  text: html.replace(/<[^>]+>/g, ''),
  pinned,
  tag,
  classes,
});

const slide = (id: string, position: number, slots: SlideSlot[], notes = ''): DeckSlide => ({
  id,
  position,
  layout: 'stat-row',
  html: '',
  notes,
  slots,
});

const deckOf = (slides: DeckSlide[]): DeckDetail =>
  ({
    id: 'd1',
    title: 'Launch',
    themeName: 'ink',
    themeCss: '',
    stage: 'slides',
    storyline: [],
    slides,
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
  }) as DeckDetail;

describe('classifySlot', () => {
  it('picks the first matching style', () => {
    expect(classifySlot(slot('kicker', 'p', ['kicker'], 'Q3'))).toBe('kicker');
    expect(classifySlot(slot('headline', 'h1', ['headline'], 'Hi'))).toBe('heading');
    expect(classifySlot(slot('title', 'h2', [], 'Hi'))).toBe('heading');
    expect(classifySlot(slot('bullet-1', 'li', [], 'One'))).toBe('bullet');
    expect(classifySlot(slot('stat-1', 'div', ['stat'], '42%'))).toBe('figure');
    expect(classifySlot(slot('stat-2', 'b', [], '42%'))).toBe('figure');
    expect(classifySlot(slot('long', 'b', [], 'This bold text is a whole sentence'))).toBe('paragraph');
    expect(classifySlot(slot('quote', 'blockquote', [], 'Wow'))).toBe('quote');
    expect(classifySlot(slot('who', 'p', ['cite'], 'Ada'))).toBe('cite');
    expect(classifySlot(slot('fn', 'p', ['footnote'], 'Source'))).toBe('footnote');
    expect(classifySlot(slot('body', 'p', [], 'Words'))).toBe('paragraph');
  });

  it('groups bullets into one list and pairs a figure with its caption', () => {
    const items = groupSlots([
      slot('b1', 'li', [], 'One'),
      slot('b2', 'li', [], 'Two'),
      slot('stat', 'b', [], '42%'),
      slot('label', 'span', ['label'], 'faster'),
      slot('body', 'p', [], 'Words'),
    ]);
    expect(items.map((i) => i.type)).toEqual(['list', 'figure', 'block']);
    expect(items[0].type === 'list' && items[0].slots).toHaveLength(2);
    expect(items[1].type === 'figure' && items[1].caption?.name).toBe('label');
  });
});

describe('inlineHtmlToMarkdown', () => {
  it('converts strong, em and breaks', () => {
    expect(inlineHtmlToMarkdown('Hello <strong>big</strong> <b>bold</b> <em>soft</em> <i>it</i>')).toBe(
      'Hello **big** **bold** _soft_ _it_',
    );
    expect(inlineHtmlToMarkdown('one<br>two')).toBe('one  \ntwo');
  });
  it('drops other markup and unescapes entities', () => {
    expect(inlineHtmlToMarkdown('R&amp;D <span class="accent">3x</span>')).toBe('R&D 3x');
  });
});

describe('deckToMarkdown', () => {
  it('writes each slide as a section with the right syntax per block', () => {
    const md = deckToMarkdown(
      deckOf([
        slide(
          'a',
          0,
          [
            slot('kicker', 'p', ['kicker'], 'Q3 review'),
            slot('headline', 'h1', ['headline'], 'Builds got <strong>faster</strong>'),
            slot('b1', 'li', [], 'Cached <em>deps</em>'),
            slot('b2', 'li', [], 'Parallel jobs'),
            slot('stat', 'b', [], '45%'),
            slot('label', 'span', ['label'], 'less time'),
            slot('quote', 'blockquote', [], 'Finally.'),
            slot('who', 'p', ['cite'], 'Ada'),
            slot('body', 'p', [], 'Plain words'),
          ],
          'Say hello\nThen pause',
        ),
        slide('b', 1, [slot('headline', 'h1', ['headline'], 'Next')]),
      ]),
    );
    expect(md).toBe(
      [
        '## Slide 1',
        '*Q3 review*',
        '# Builds got **faster**',
        '- Cached _deps_\n- Parallel jobs',
        '**45%** less time',
        '> Finally.',
        '> — Ada',
        'Plain words',
        '> Notes: Say hello\n> Then pause',
        '## Slide 2',
        '# Next',
      ]
        .join('\n\n') + '\n',
    );
  });

  it('is empty for a deck with no slides', () => {
    expect(deckToMarkdown(deckOf([]))).toBe('');
  });
});
