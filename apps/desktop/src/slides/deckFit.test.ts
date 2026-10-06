import { describe, expect, it } from 'vitest';
import { DECK_FIT_SCRIPT } from './deckFit';

interface Box { left: number; top: number; right: number; bottom: number }
interface ConduitFit {
  nextStatSize(size: number, wide: boolean, lines: number): number | null;
  nextSlotSize(size: number, base: number, wide: boolean): number | null;
  denseSize(size: number, floor: number): number;
  denseSvgHeight(height: number): number;
  overflowPx(box: Box | null, scrollW: number, scrollH: number): number;
  fitSlide(slide: HTMLElement): boolean;
  unfit(slide: HTMLElement): void;
  overflow(slide: HTMLElement): number;
  cleanSlotHtml(slot: HTMLElement): string;
}

// The source the frame, the HTML export and the print document all run.
const fit = new Function(`${DECK_FIT_SCRIPT}; return conduitFit;`)() as ConduitFit;

describe('fit decisions', () => {
  it('shrinks a stat value 10% a step to the 64px floor, and only at the floor lets it wrap', () => {
    expect(fit.nextStatSize(168, false, 1)).toBeNull();
    expect(fit.nextStatSize(168, true, 1)).toBeCloseTo(151.2);
    expect(fit.nextStatSize(168, false, 2)).toBeCloseTo(151.2);
    expect(fit.nextStatSize(70, true, 1)).toBe(64);
    expect(fit.nextStatSize(64, true, 2)).toBeNull();
    let size = 168;
    let steps = 0;
    for (let next = fit.nextStatSize(size, true, 1); next !== null; next = fit.nextStatSize(size, true, 1)) {
      size = next;
      steps++;
    }
    expect(size).toBe(64);
    expect(steps).toBeLessThanOrEqual(16);
  });

  it('shrinks a slot with a too-wide token to half its own size at most', () => {
    expect(fit.nextSlotSize(80, 80, false)).toBeNull();
    expect(fit.nextSlotSize(80, 80, true)).toBe(72);
    expect(fit.nextSlotSize(42, 80, true)).toBe(40);
    expect(fit.nextSlotSize(40, 80, true)).toBeNull();
  });

  it('gives 6% a dense round down to each floor, and drawings 10% to 240px', () => {
    expect(fit.denseSize(100, 56)).toBe(94);
    expect(fit.denseSize(58, 56)).toBe(56);
    expect(fit.denseSize(56, 56)).toBe(56);
    expect(fit.denseSize(30, 56)).toBe(30);
    expect(fit.denseSvgHeight(600)).toBe(540);
    expect(fit.denseSvgHeight(250)).toBe(240);
  });

  it('measures overflow on every side, past a 16px tolerance', () => {
    const inside = { left: 120, top: 120, right: 1800, bottom: 960 };
    expect(fit.overflowPx(inside, 1920, 1080)).toBe(0);
    expect(fit.overflowPx({ ...inside, top: -140 }, 1920, 1080)).toBe(140);
    expect(fit.overflowPx({ ...inside, left: -30 }, 1920, 1080)).toBe(30);
    expect(fit.overflowPx({ ...inside, bottom: 1200 }, 1920, 1080)).toBe(120);
    expect(fit.overflowPx({ ...inside, bottom: 1090 }, 1920, 1080)).toBe(0);
    // Scroll extents still count: a descendant can spill out of its child box.
    expect(fit.overflowPx(inside, 1920, 1180)).toBe(100);
    expect(fit.overflowPx(null, 2000, 1080)).toBe(80);
  });
});

// jsdom does no layout, so this fakes just enough geometry for the glue: a
// slide at 0.5 scale, and stat values whose width follows their font size.
function laidOutSlide(html: string, columnWidth: number, textWidth = columnWidth) {
  const slide = document.createElement('section');
  slide.className = 'slide';
  slide.innerHTML = html;
  document.body.appendChild(slide);
  const rect = (width: number, height: number) => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}) });
  slide.getBoundingClientRect = () => rect(960, 540) as DOMRect;
  const size = (el: Element) => parseFloat((el as HTMLElement).style.fontSize) || 168;
  for (const el of Array.from(slide.querySelectorAll('*'))) {
    (el as HTMLElement).getBoundingClientRect = () => rect(100, 100) as DOMRect;
    Object.defineProperty(el, 'clientWidth', { get: () => columnWidth });
    Object.defineProperty(el, 'offsetHeight', { get: () => size(el) });
    Object.defineProperty(el, 'scrollWidth', {
      get: () => (el.matches('.stat > b') ? Math.ceil((el.textContent ?? '').length * size(el) * 0.6) : textWidth),
    });
  }
  return slide;
}

describe('fitSlide glue', () => {
  // From a model-written deck: inline sizes on every value, an accent span in one.
  const html =
    '<h1 class="headline" data-text="headline">The quarter at a glance</h1>' +
    '<div class="stat" data-text="s1"><b style="font-size:168px; color:var(--accent);">$28.6M</b><span>Annual recurring revenue</span></div>' +
    '<div class="stat"><b data-text="stat-2" style="font-size:168px"><span class="accent">33.5B → 48GB</span></b><span>65B model on one GPU</span></div>';

  it('does nothing until the slide is laid out', () => {
    const slide = document.createElement('section');
    slide.innerHTML = html;
    expect(fit.fitSlide(slide)).toBe(false);
    expect(slide.hasAttribute('data-fit')).toBe(false);
  });

  it('shrinks stat values to one shared size, keeps fitted sizes out of slot HTML, and undoes cleanly', () => {
    const slide = laidOutSlide(html, 420);
    expect(fit.fitSlide(slide)).toBe(true);
    const [a, b] = Array.from(slide.querySelectorAll<HTMLElement>('.stat > b'));
    expect(a.style.getPropertyPriority('font-size')).toBe('important');
    const shared = parseFloat(a.style.fontSize);
    expect(shared).toBeLessThan(168);
    expect(shared).toBeGreaterThanOrEqual(64);
    expect(parseFloat(b.style.fontSize)).toBe(shared);
    expect(Number(slide.getAttribute('data-fit'))).toBeGreaterThan(0);

    // The first stat is itself a slot: its innerHTML shows the value as written.
    const slot = slide.querySelector<HTMLElement>('[data-text="s1"]')!;
    expect(slot.innerHTML).toContain('!important');
    const clean = fit.cleanSlotHtml(slot);
    expect(clean).toContain('style="font-size:168px; color:var(--accent);"');
    expect(clean).not.toContain('important');

    fit.unfit(slide);
    expect(a.getAttribute('style')).toBe('font-size:168px; color:var(--accent);');
    expect(b.getAttribute('style')).toBe('font-size:168px');
    expect(slide.hasAttribute('data-fit')).toBe(false);
    slide.remove();
  });

  it('never touches text inside an svg', () => {
    // (display:block so only the svg rule, not the inline-element rule, can skip it)
    const slide = laidOutSlide(
      '<svg viewBox="0 0 1680 640"><text data-text="label" style="display:block; font-size:28px">A very long label inside the drawing</text></svg>',
      400,
      4000,
    );
    fit.fitSlide(slide);
    expect(slide.querySelector('text')!.getAttribute('style')).toBe('display:block; font-size:28px');
    slide.remove();
  });
});
