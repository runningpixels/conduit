import type { Translate } from '../i18n';
import type { DeckSlide } from '../ipc/contracts';
import type { DeckTurnEnd } from './buildContinuation';

/// The layout report: what the deck frame measured on each slide
/// (`deckLayoutCheck.ts`), and what the app does with it.
///
/// - The model gets the problems as plain sentences: every line names the
///   slide, what a viewer sees, the measured cause and one way to fix it. They
///   go into the per-turn developer prompt for every slide that has them.
/// - After a deck turn that changed slides, the app sends one automatic
///   "layout check" turn listing only the problems on those slides. Never a
///   second: whatever the check turn leaves is shown to the user as a note in
///   the thread, not sent again.

export type LayoutIssue =
  | { kind: 'overlap'; slots: [string, string] }
  | { kind: 'clipped'; slot: string; by: number }
  | { kind: 'svg-small-text'; px: number; viewBox: string; width: number; height: number; scale: number }
  | { kind: 'svg-empty'; pct: number; width: number; height: number }
  | { kind: 'svg-clipped'; by: number };

/** One slide's measurements, as the stage frame reports them. */
export interface SlideLayout {
  id: string;
  /** `slideSignature` of the slide the frame measured: tells a fresh report from a stale one. */
  sig: string;
  /** How far the content runs past the canvas, after the auto-fit (0 fits). */
  px: number;
  /** The auto-fit had to shrink the whole slide toward its floors. */
  dense: boolean;
  /** The smallest text size on the slide outside drawings (px). */
  minFont: number;
  issues: LayoutIssue[];
}

/** Slide id to its latest measurements. */
export type DeckLayoutReport = Record<string, SlideLayout>;

/**
 * A short fingerprint of what the frame renders for a slide. The parent puts
 * it in every posted slide and the frame echoes it in its report, so the app
 * can tell when a report describes the deck it has now.
 */
export function slideSignature(layout: string, html: string): string {
  const text = `${layout}\n${html}`;
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return `${text.length.toString(36)}.${hash.toString(36)}`;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === 'string';

function parseIssue(value: unknown): LayoutIssue | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  switch (v.kind) {
    case 'overlap':
      return Array.isArray(v.slots) && v.slots.length === 2 && str(v.slots[0]) && str(v.slots[1])
        ? { kind: 'overlap', slots: [v.slots[0], v.slots[1]] }
        : null;
    case 'clipped':
      return str(v.slot) && num(v.by) ? { kind: 'clipped', slot: v.slot, by: Math.round(v.by) } : null;
    case 'svg-small-text':
      return num(v.px) && str(v.viewBox) && num(v.width) && num(v.height) && num(v.scale)
        ? { kind: 'svg-small-text', px: Math.round(v.px), viewBox: v.viewBox, width: Math.round(v.width), height: Math.round(v.height), scale: v.scale }
        : null;
    case 'svg-empty':
      return num(v.pct) && num(v.width) && num(v.height)
        ? { kind: 'svg-empty', pct: Math.round(v.pct), width: Math.round(v.width), height: Math.round(v.height) }
        : null;
    case 'svg-clipped':
      return num(v.by) ? { kind: 'svg-clipped', by: Math.round(v.by) } : null;
    default:
      return null;
  }
}

/** Reads one slide of a frame report; null when the shape is wrong. Issues of
 *  an unknown kind are dropped, not fatal. */
export function parseSlideLayout(value: unknown): SlideLayout | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!str(v.id) || !str(v.sig) || !num(v.px) || typeof v.dense !== 'boolean' || !num(v.minFont) || !Array.isArray(v.issues)) {
    return null;
  }
  const issues: LayoutIssue[] = [];
  for (const raw of v.issues) {
    const issue = parseIssue(raw);
    if (issue) issues.push(issue);
  }
  return { id: v.id, sig: v.sig, px: Math.max(0, Math.round(v.px)), dense: v.dense, minFont: Math.round(v.minFont), issues };
}

/** Slide id to overflow px, only slides that overflow. */
export function overflowOf(report: DeckLayoutReport): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, slide] of Object.entries(report)) if (slide.px > 0) out[id] = slide.px;
  return out;
}

/** The problems on one slide as sentences for the model; empty when it renders fine. */
export function slideProblems(slide: SlideLayout, t: Translate): string[] {
  const out: string[] = [];
  if (slide.px > 0) out.push(t('slides.layout.problem.overflow', { px: slide.px }));
  else if (slide.dense) out.push(t('slides.layout.problem.tooFull', { px: slide.minFont }));
  for (const issue of slide.issues) {
    switch (issue.kind) {
      case 'overlap':
        out.push(t('slides.layout.problem.overlap', { a: issue.slots[0], b: issue.slots[1] }));
        break;
      // Text past the edge of a slide that overflows is already said above.
      case 'clipped':
        if (slide.px === 0) out.push(t('slides.layout.problem.clipped', { slot: issue.slot, px: issue.by }));
        break;
      case 'svg-small-text':
        out.push(
          t('slides.layout.problem.svgSmallText', {
            px: issue.px,
            viewBox: issue.viewBox || '-',
            // Sizes as the model writes them in a viewBox: no digit grouping.
            width: String(issue.width),
            height: String(issue.height),
            scale: String(issue.scale),
          }),
        );
        break;
      case 'svg-empty':
        out.push(
          t('slides.layout.problem.svgEmpty', { pct: issue.pct, width: String(issue.width), height: String(issue.height) }),
        );
        break;
      case 'svg-clipped':
        out.push(t('slides.layout.problem.svgClipped'));
        break;
    }
  }
  return out;
}

/** Slide id to its problems joined into one note, for the developer prompt. */
export function layoutNotesBySlide(report: DeckLayoutReport, t: Translate): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, slide] of Object.entries(report)) {
    const problems = slideProblems(slide, t);
    if (problems.length > 0) out[id] = problems.join(' ');
  }
  return out;
}

/** A slide's report without the issues that only the user's own (pinned)
 *  text could fix: the model must keep that text, so it cannot act on them. */
export function withoutPinnedOnlyIssues(slide: SlideLayout, deckSlide: Pick<DeckSlide, 'slots'>): SlideLayout {
  const slots = deckSlide.slots ?? [];
  const pinned = (name: string) => {
    const named = slots.filter((slot) => slot.name === name);
    return named.length > 0 && named.every((slot) => slot.pinned);
  };
  const issues = slide.issues.filter((issue) => {
    if (issue.kind === 'clipped') return !pinned(issue.slot);
    if (issue.kind === 'overlap') return !(pinned(issue.slots[0]) && pinned(issue.slots[1]));
    return true;
  });
  return issues.length === slide.issues.length ? slide : { ...slide, issues };
}

/** The slides whose rendered content differs from `before` (slide id to
 *  signature, taken before the turn), new slides included, in deck order. */
export function changedSlides(before: ReadonlyMap<string, string>, slides: readonly DeckSlide[]): string[] {
  return [...slides]
    .sort((a, b) => a.position - b.position)
    .filter((slide) => before.get(slide.id) !== slideSignature(slide.layout, slide.html))
    .map((slide) => slide.id);
}

/** Slide id to signature, the `before` of `changedSlides`. */
export function slideSignatures(slides: readonly DeckSlide[]): Map<string, string> {
  return new Map(slides.map((slide) => [slide.id, slideSignature(slide.layout, slide.html)]));
}

/** The report describes these slides as they are now: every one of them was
 *  measured with its current content. */
export function reportIsCurrent(
  report: DeckLayoutReport,
  slides: readonly DeckSlide[],
  ids: readonly string[],
): boolean {
  const byId = new Map(slides.map((slide) => [slide.id, slide]));
  return ids.every((id) => {
    const slide = byId.get(id);
    // A slide deleted since needs no report.
    return !slide || report[id]?.sig === slideSignature(slide.layout, slide.html);
  });
}

/** Which turn is ending: an ordinary deck turn, or the automatic layout check. */
export type LayoutCheckPhase = 'turn' | 'check';

export type LayoutCheckDecision =
  | { action: 'none' }
  /** Send this text as the one automatic layout-check turn. */
  | { action: 'send'; text: string; slideIds: string[] }
  /** Show this text to the user as a note in the thread. */
  | { action: 'note'; text: string };

/**
 * What to do with the layout report after a deck turn:
 * - nothing when the user stopped the turn, the turn changed no slides, no
 *   current report arrived, or the changed slides render fine;
 * - after an ordinary turn that completed (or hit its time limit), send one
 *   layout-check turn listing only the changed slides' problems;
 * - after the layout-check turn, or a turn that failed, or when the only
 *   problems are in the user's own pinned text, show the problems to the user
 *   as a note instead. Never a second automatic turn.
 *
 * `slideIds` are the slides the turn changed (for the check turn: those it
 * was sent about plus any it changed). `report` is null when no current
 * report arrived in time.
 */
export function layoutCheckDecision(
  input: {
    phase: LayoutCheckPhase;
    turnEnd: DeckTurnEnd;
    slideIds: readonly string[];
    slides: readonly DeckSlide[];
    report: DeckLayoutReport | null;
  },
  t: Translate,
): LayoutCheckDecision {
  if (input.turnEnd === 'stopped' || input.slideIds.length === 0 || !input.report) return { action: 'none' };
  const wanted = new Set(input.slideIds);
  const report = input.report;
  const slides = [...input.slides].sort((a, b) => a.position - b.position).filter((slide) => wanted.has(slide.id));
  const lines: string[] = [];
  const noteItems: string[] = [];
  const sendIds: string[] = [];
  for (const slide of slides) {
    const measured = report[slide.id];
    if (!measured || measured.sig !== slideSignature(slide.layout, slide.html)) continue;
    const n = slide.position + 1;
    if (slideProblems(measured, t).length === 0) continue;
    noteItems.push(noteItem(measured, n, t));
    const fixable = slideProblems(withoutPinnedOnlyIssues(measured, slide), t);
    if (fixable.length > 0) {
      lines.push(`- ${t('slides.layout.line', { n, layout: slide.layout, problems: fixable.join(' ') })}`);
      sendIds.push(slide.id);
    }
  }
  if (noteItems.length === 0) return { action: 'none' };
  const sendable = input.phase === 'turn' && (input.turnEnd === 'completed' || input.turnEnd === 'time-limit');
  if (sendable && lines.length > 0) {
    return { action: 'send', text: t('slides.layout.prompt', { lines: lines.join('\n') }), slideIds: sendIds };
  }
  return { action: 'note', text: t('slides.layout.note', { items: noteItems.join('; ') }) };
}

/** The user-facing summary of one slide's problems: the most visible one. */
function noteItem(slide: SlideLayout, n: number, t: Translate): string {
  if (slide.px > 0 || slide.dense) return t('slides.layout.noteItem.tooFull', { n });
  if (slide.issues.some((issue) => issue.kind === 'overlap')) return t('slides.layout.noteItem.overlap', { n });
  if (slide.issues.some((issue) => issue.kind === 'clipped')) return t('slides.layout.noteItem.clipped', { n });
  return t('slides.layout.noteItem.diagram', { n });
}
