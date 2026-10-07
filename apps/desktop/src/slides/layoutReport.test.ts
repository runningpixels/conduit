import { describe, expect, it } from 'vitest';
import type { DeckSlide } from '../ipc/contracts';
import { enTranslate as t } from '../test/enTranslate';
import {
  changedSlides,
  layoutCheckDecision,
  layoutNotesBySlide,
  overflowOf,
  parseSlideLayout,
  reportIsCurrent,
  slideProblems,
  slideSignature,
  slideSignatures,
  withoutPinnedOnlyIssues,
  type DeckLayoutReport,
  type SlideLayout,
} from './layoutReport';

function slide(id: string, position: number, layout: string, html: string, pinned: string[] = []): DeckSlide {
  const names = [...html.matchAll(/data-text="([^"]+)"/g)].map((m) => m[1]);
  return {
    id,
    position,
    layout,
    html,
    notes: '',
    slots: names.map((name, index) => ({ index, name, html: '', text: '', pinned: pinned.includes(name), tag: 'p', classes: [] })),
  };
}

const s1 = slide('s1', 0, 'title', '<h1 data-text="headline">Hello</h1>');
const s2 = slide('s2', 1, 'stat-row', '<h1 data-text="headline">Numbers</h1><p data-text="footnote">Source</p>');
const s3 = slide('s3', 2, 'custom', '<h1 data-text="headline">Mine</h1><p data-text="sub">Ours</p>', ['headline', 'sub']);
const slides = [s1, s2, s3];

const clean = (s: DeckSlide): SlideLayout => ({
  id: s.id,
  sig: slideSignature(s.layout, s.html),
  px: 0,
  dense: false,
  minFont: 40,
  issues: [],
});

describe('slideSignature', () => {
  it('is stable and changes with the layout or the HTML', () => {
    expect(slideSignature('title', '<h1>x</h1>')).toBe(slideSignature('title', '<h1>x</h1>'));
    expect(slideSignature('title', '<h1>x</h1>')).not.toBe(slideSignature('statement', '<h1>x</h1>'));
    expect(slideSignature('title', '<h1>x</h1>')).not.toBe(slideSignature('title', '<h1>y</h1>'));
  });
});

describe('parseSlideLayout', () => {
  it('reads a frame report, rounding and dropping issues it does not know', () => {
    expect(
      parseSlideLayout({
        id: 'a',
        sig: 'x',
        px: 12.6,
        dense: false,
        minFont: 33.4,
        issues: [{ kind: 'clipped', slot: 'footnote', by: 20.2 }, { kind: 'crowds-edge', slot: 'x' }, { kind: 'overlap', slots: ['a'] }],
      }),
    ).toEqual({ id: 'a', sig: 'x', px: 13, dense: false, minFont: 33, issues: [{ kind: 'clipped', slot: 'footnote', by: 20 }] });
  });

  it('rejects a slide without its signature or measurements', () => {
    expect(parseSlideLayout({ id: 'a', px: 0, dense: false, minFont: 30, issues: [] })).toBeNull();
    expect(parseSlideLayout({ id: 'a', sig: 'x', px: Number.NaN, dense: false, minFont: 30, issues: [] })).toBeNull();
    expect(parseSlideLayout({ id: 'a', sig: 'x', px: 0, dense: 'no', minFont: 30, issues: [] })).toBeNull();
    expect(parseSlideLayout(null)).toBeNull();
  });
});

describe('slideProblems', () => {
  it('words each problem with what a viewer sees and one way to fix it', () => {
    const report: SlideLayout = {
      ...clean(s2),
      dense: true,
      minFont: 30,
      issues: [
        { kind: 'overlap', slots: ['headline', 'sub'] },
        { kind: 'clipped', slot: 'footnote', by: 20 },
        { kind: 'svg-small-text', px: 11, viewBox: '0 0 1640 600', width: 820, height: 600, scale: 0.5 },
        { kind: 'svg-empty', pct: 12, width: 1680, height: 640 },
        { kind: 'svg-clipped', by: 30 },
        { kind: 'footnote-crowded', px: 6 },
      ],
    };
    expect(slideProblems(report, t)).toEqual([
      'too much content: the theme had to shrink the text to its minimum to fit (smallest text 30px). Cut it down to the essentials or split it into two slides.',
      '"headline" runs into "sub". Shorten one of them or move one to another slide.',
      '"footnote" is cut off at the slide edge by 20px. Shorten the slide.',
      "the diagram's smallest labels render at 11px, too small to read from across a room: its viewBox (0 0 1640 600) is drawn into a 820x600px box, so every font-size is scaled by 0.5. Redraw it with a viewBox about 820 wide and no font-size below 24.",
      "the diagram fills only 12% of its 1680x640px box. Use a viewBox that matches the box's shape.",
      'the diagram is cut off at the slide edge.',
      "the text above the footnote runs into it (6px apart). Cut a line or move the footnote's note into the body.",
    ]);
  });

  it('says overflow once: not also dense, nor each slot cut off by it', () => {
    const report: SlideLayout = {
      ...clean(s2),
      px: 140,
      dense: true,
      issues: [{ kind: 'clipped', slot: 'footnote', by: 140 }],
    };
    expect(slideProblems(report, t)).toEqual([
      'too much content: even with the text at its smallest it runs 140px past the slide edge. Cut it down to the essentials or split it into two slides.',
    ]);
  });

  it('is empty for a slide that renders fine', () => {
    expect(slideProblems(clean(s1), t)).toEqual([]);
  });
});

describe('report helpers', () => {
  const report: DeckLayoutReport = { s1: clean(s1), s2: { ...clean(s2), px: 90 } };

  it('keeps overflow per slide and notes only slides with problems', () => {
    expect(overflowOf(report)).toEqual({ s2: 90 });
    expect(Object.keys(layoutNotesBySlide(report, t))).toEqual(['s2']);
    expect(layoutNotesBySlide(report, t).s2).toContain('runs 90px past the slide edge');
  });

  it('finds the slides a turn changed or added, in deck order', () => {
    const before = slideSignatures([s1, s2]);
    const edited = { ...s2, html: '<h1 data-text="headline">More numbers</h1>' };
    expect(changedSlides(before, [s3, edited, s1])).toEqual(['s2', 's3']);
    expect(changedSlides(before, [s1, s2])).toEqual([]);
  });

  it('tells a report of the deck as it is from a stale one', () => {
    expect(reportIsCurrent(report, slides, ['s1', 's2'])).toBe(true);
    expect(reportIsCurrent(report, slides, ['s3'])).toBe(false);
    const edited = { ...s1, html: '<h1 data-text="headline">Hi</h1>' };
    expect(reportIsCurrent(report, [edited, s2], ['s1'])).toBe(false);
    // A slide deleted since needs no report.
    expect(reportIsCurrent(report, [s1], ['s1', 'gone'])).toBe(true);
  });

  it("drops issues only the user's pinned text could fix", () => {
    const measured: SlideLayout = {
      ...clean(s3),
      issues: [
        { kind: 'overlap', slots: ['headline', 'sub'] },
        { kind: 'clipped', slot: 'sub', by: 30 },
        { kind: 'svg-clipped', by: 10 },
      ],
    };
    expect(withoutPinnedOnlyIssues(measured, s3).issues).toEqual([{ kind: 'svg-clipped', by: 10 }]);
    const unpinned = slide('s3', 2, 'custom', s3.html, ['headline']);
    expect(withoutPinnedOnlyIssues(measured, unpinned).issues).toHaveLength(3);
  });
});

describe('layoutCheckDecision', () => {
  const tooFull = (s: DeckSlide): SlideLayout => ({ ...clean(s), dense: true, minFont: 30 });
  const report: DeckLayoutReport = { s1: clean(s1), s2: tooFull(s2), s3: clean(s3) };
  const base = { phase: 'turn' as const, turnEnd: 'completed' as const, slideIds: ['s1', 's2'], slides, report };

  it('sends one layout check listing only the changed slides with problems', () => {
    const decision = layoutCheckDecision({ ...base, report: { ...report, s3: tooFull(s3) } }, t);
    expect(decision).toEqual({
      action: 'send',
      slideIds: ['s2'],
      text:
        'Layout check (automatic): these problems are visible on the slides. Fix only these; keep everything else as it is.\n' +
        '- Slide 2 (stat-row): too much content: the theme had to shrink the text to its minimum to fit (smallest text 30px). Cut it down to the essentials or split it into two slides.',
    });
  });

  it('also checks after a turn that hit its time limit', () => {
    expect(layoutCheckDecision({ ...base, turnEnd: 'time-limit' }, t).action).toBe('send');
  });

  it('does nothing when the user stopped the turn, it changed no slides, or no current report came', () => {
    expect(layoutCheckDecision({ ...base, turnEnd: 'stopped' }, t)).toEqual({ action: 'none' });
    expect(layoutCheckDecision({ ...base, slideIds: [] }, t)).toEqual({ action: 'none' });
    expect(layoutCheckDecision({ ...base, report: null }, t)).toEqual({ action: 'none' });
    const stale = { ...report, s2: { ...tooFull(s2), sig: 'old' } };
    expect(layoutCheckDecision({ ...base, report: stale }, t)).toEqual({ action: 'none' });
  });

  it('does nothing when the changed slides render fine', () => {
    expect(layoutCheckDecision({ ...base, slideIds: ['s1', 's3'] }, t)).toEqual({ action: 'none' });
  });

  it('never chains: after the layout check turn, what is left is a note for the user', () => {
    expect(layoutCheckDecision({ ...base, phase: 'check' }, t)).toEqual({
      action: 'note',
      text: 'Layout check: slide 2 is still too full.',
    });
  });

  it('notes instead of sending after a failed turn', () => {
    expect(layoutCheckDecision({ ...base, turnEnd: 'failed' }, t).action).toBe('note');
  });

  it("notes instead of sending when only the user's pinned text could fix it", () => {
    const pinnedOnly: SlideLayout = { ...clean(s3), issues: [{ kind: 'overlap', slots: ['headline', 'sub'] }] };
    expect(layoutCheckDecision({ ...base, slideIds: ['s3'], report: { ...report, s3: pinnedOnly } }, t)).toEqual({
      action: 'note',
      text: 'Layout check: text still overlaps on slide 3.',
    });
  });

  it('names each slide in the note by its most visible problem', () => {
    const decision = layoutCheckDecision(
      {
        ...base,
        phase: 'check',
        slideIds: ['s1', 's2', 's3'],
        report: {
          s1: { ...clean(s1), issues: [{ kind: 'clipped', slot: 'headline', by: 9 }] },
          s2: { ...clean(s2), issues: [{ kind: 'svg-empty', pct: 10, width: 1680, height: 640 }] },
          s3: { ...clean(s3), px: 40 },
        },
      },
      t,
    );
    expect(decision).toEqual({
      action: 'note',
      text: 'Layout check: text is still cut off on slide 1; the diagram on slide 2 is still hard to read; slide 3 is still too full.',
    });
  });
});
