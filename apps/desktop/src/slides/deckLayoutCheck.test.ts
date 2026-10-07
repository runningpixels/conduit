import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DECK_LAYOUT_SCRIPT } from './deckLayoutCheck';

interface Box { x: number; y: number; w: number; h: number }
interface ConduitLayout {
  intersect(a: Box, b: Box): number;
  overlaps(a: Box, b: Box): boolean;
  outside(b: Box): number;
  textBox(glyph: Box, line: Box, font: number): Box;
  svgScale(box: Box, viewBox: { w: number; h: number } | null): number;
  svgTextTooSmall(px: number): boolean;
  svgMostlyEmpty(drawingPct: number, box: Box): boolean;
  dense(rounds: number): boolean;
  check(slide: HTMLElement): { dense: boolean; minFont: number; issues: Array<Record<string, unknown>> } | null;
}

// The source the stage frame runs.
const layout = new Function(`${DECK_LAYOUT_SCRIPT}; return conduitLayout;`)() as ConduitLayout;

describe('layout decisions', () => {
  it('counts an overlap only past 400 px² and 4% of the smaller box', () => {
    const a = { x: 0, y: 0, w: 400, h: 100 };
    expect(layout.overlaps(a, { x: 300, y: 0, w: 400, h: 100 })).toBe(true);
    // 10 x 30 = 300 px²: a touch, not an overlap.
    expect(layout.overlaps(a, { x: 390, y: 70, w: 400, h: 100 })).toBe(false);
    // 3000 px², but only 3% of the smaller box (1000 x 100).
    expect(layout.overlaps({ x: 0, y: 0, w: 1000, h: 1000 }, { x: 0, y: 997, w: 1000, h: 100 })).toBe(false);
    expect(layout.overlaps(a, { x: 0, y: 200, w: 1000, h: 100 })).toBe(false);
  });

  it('measures how far a box runs past the slide edge, with a few px of slack', () => {
    expect(layout.outside({ x: 100, y: 100, w: 500, h: 100 })).toBe(0);
    expect(layout.outside({ x: 100, y: 1000, w: 500, h: 84 })).toBe(0);
    expect(layout.outside({ x: 100, y: 1000, w: 500, h: 120 })).toBe(40);
    expect(layout.outside({ x: -30, y: 0, w: 100, h: 100 })).toBe(30);
    expect(layout.outside({ x: 1800, y: 0, w: 200, h: 100 })).toBe(80);
  });

  it('takes a text box vertically from its line box unless the glyphs clearly spill out', () => {
    const line = { x: 0, y: 100, w: 800, h: 100 };
    expect(layout.textBox({ x: 10, y: 92, w: 600, h: 116 }, line, 100)).toEqual({ x: 10, y: 100, w: 600, h: 100 });
    expect(layout.textBox({ x: 10, y: 100, w: 600, h: 300 }, line, 100)).toEqual({ x: 10, y: 100, w: 600, h: 300 });
  });

  it('scales svg text by the box over the viewBox, meet-fitted', () => {
    expect(layout.svgScale({ x: 0, y: 0, w: 820, h: 600 }, { w: 1640, h: 600 })).toBe(0.5);
    expect(layout.svgScale({ x: 0, y: 0, w: 1680, h: 640 }, { w: 1680, h: 640 })).toBe(1);
    expect(layout.svgScale({ x: 0, y: 0, w: 820, h: 600 }, null)).toBe(1);
    expect(layout.svgTextTooSmall(11)).toBe(true);
    expect(layout.svgTextTooSmall(18)).toBe(false);
  });

  it('flags a mostly empty drawing only when its box is large', () => {
    expect(layout.svgMostlyEmpty(12, { x: 0, y: 0, w: 1680, h: 640 })).toBe(true);
    expect(layout.svgMostlyEmpty(25, { x: 0, y: 0, w: 1680, h: 640 })).toBe(false);
    expect(layout.svgMostlyEmpty(5, { x: 0, y: 0, w: 300, h: 200 })).toBe(false);
  });

  it('calls a slide dense from three whole-slide shrink rounds', () => {
    expect(layout.dense(2)).toBe(false);
    expect(layout.dense(3)).toBe(true);
  });
});

describe('check', () => {
  // jsdom lays nothing out: give each element the box a browser would.
  const boxes = new Map<Element, Box>();
  const rect = (b: Box | undefined) => {
    const r = b ?? { x: 0, y: 0, w: 0, h: 0 };
    return { left: r.x, top: r.y, width: r.w, height: r.h, right: r.x + r.w, bottom: r.y + r.h, x: r.x, y: r.y } as DOMRect;
  };
  const originalElement = Element.prototype.getBoundingClientRect;
  const originalRange = (Range.prototype as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
  beforeAll(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return rect(boxes.get(this));
    };
    Range.prototype.getBoundingClientRect = function (this: Range) {
      return rect(boxes.get(this.startContainer as Element));
    };
  });
  afterEach(() => boxes.clear());
  afterAll(() => {
    Element.prototype.getBoundingClientRect = originalElement;
    if (originalRange) Range.prototype.getBoundingClientRect = originalRange;
  });

  function slideWith(html: string, layoutBoxes: Record<string, Box>): HTMLElement {
    const slide = document.createElement('section');
    slide.innerHTML = html;
    document.body.appendChild(slide);
    boxes.set(slide, { x: 0, y: 0, w: 1920, h: 1080 });
    for (const [selector, b] of Object.entries(layoutBoxes)) boxes.set(slide.querySelector(selector)!, b);
    return slide;
  }

  it('reports overlapping slots, text past the edge and unreadable svg labels', () => {
    const slide = slideWith(
      '<h1 data-text="headline" style="font-size: 80px">Revenue tripled</h1>' +
        '<p data-text="sub" style="font-size: 34px">in one year</p>' +
        '<p data-text="footnote" style="font-size: 24px">Source: finance</p>' +
        '<svg><text style="font-size: 11px">Q1</text></svg>',
      {
        '[data-text="headline"]': { x: 120, y: 200, w: 1200, h: 100 },
        '[data-text="sub"]': { x: 120, y: 260, w: 600, h: 60 },
        '[data-text="footnote"]': { x: 120, y: 1060, w: 400, h: 40 },
        svg: { x: 120, y: 400, w: 820, h: 600 },
      },
    );
    slide.setAttribute('data-fit-dense', '4');
    const report = layout.check(slide);
    expect(report).toEqual({
      dense: true,
      minFont: 24,
      issues: [
        { kind: 'clipped', slot: 'footnote', by: 20 },
        { kind: 'overlap', slots: ['headline', 'sub'] },
        { kind: 'svg-small-text', px: 11, viewBox: '', width: 820, height: 600, scale: 1 },
      ],
    });
    slide.remove();
  });

  it('reports nothing for a slide that renders clean, and null before layout', () => {
    const slide = slideWith(
      '<h1 data-text="headline" style="font-size: 80px">Fine</h1><p data-text="sub" style="font-size: 34px">Also fine</p>',
      {
        '[data-text="headline"]': { x: 120, y: 200, w: 600, h: 100 },
        '[data-text="sub"]': { x: 120, y: 340, w: 600, h: 60 },
      },
    );
    expect(layout.check(slide)).toEqual({ dense: false, minFont: 34, issues: [] });
    boxes.delete(slide);
    expect(layout.check(slide)).toBeNull();
    slide.remove();
  });
});
