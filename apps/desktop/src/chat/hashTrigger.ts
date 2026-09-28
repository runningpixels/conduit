/**
 * The `#` document-reference trigger (t1-8 M3, D11) — a pure function so its
 * rules can be exhaustively unit-tested without mounting the composer.
 *
 * The trigger opens on a `#` at the start of the text or right after
 * whitespace, and the query runs from there to the caret with no whitespace
 * in it. That single rule ("`#` starts a whitespace-delimited run ending at
 * the caret") is also what makes `a#b` and `http://x/#y` inert without a
 * special case: the run ending at the caret is `a#b` / `.../#y`, which does
 * not *start* with `#`, so it is not a trigger at all.
 */

export interface HashTrigger {
  /** Index of the `#` character itself. */
  start: number;
  /** Text between the `#` and the caret — never contains whitespace. */
  query: string;
}

const WHITESPACE = /\s/;

/** `` ``` `` fences before the caret — an odd count means the caret sits
 *  inside one. */
function insideFencedCode(text: string, caret: number): boolean {
  const fences = text.slice(0, caret).match(/```/g);
  return (fences?.length ?? 0) % 2 === 1;
}

/** Single backticks on the caret's own line, before the caret — an odd count
 *  means the caret sits inside an inline code span. */
function insideInlineCode(text: string, caret: number): boolean {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const line = text.slice(lineStart, caret);
  const backticks = line.match(/`/g);
  return (backticks?.length ?? 0) % 2 === 1;
}

/**
 * Find the active `#` trigger, if any, for `text` with the caret at `caret`
 * (a `selectionStart`-style offset). Implements D11 exactly:
 *
 * - Opens on `#` at the start of the text or after whitespace; the query runs
 *   to the caret with no whitespace in it.
 * - Inert inside a fenced or inline code span, mid-word (`a#b`), inside a URL
 *   (`http://x/#y`), or on `##` (a Markdown H2).
 * - A bare `# ` (heading) closes the trigger at the space: once whitespace
 *   follows the `#`, the run ending at the caret no longer starts with `#`
 *   (or is empty), so this returns `null` and a plain Enter can create the
 *   heading rather than pick an empty query.
 *
 * Composition (IME) state is not this function's concern (D12) — the caller
 * must not invoke it, or must ignore its result, while `isComposing`.
 */
export function findHashTrigger(text: string, caret: number): HashTrigger | null {
  if (caret < 0 || caret > text.length) return null;

  // Walk back from the caret to the start of the whitespace-delimited run
  // it sits at the end of.
  let i = caret;
  while (i > 0 && !WHITESPACE.test(text[i - 1])) i--;
  const start = i;

  // No run at all (caret sits right after whitespace, or at the very start
  // with nothing typed yet).
  if (start >= caret) return null;
  if (text[start] !== '#') return null;

  const query = text.slice(start + 1, caret);
  if (query.startsWith('#')) return null; // `##…` is a heading, not a trigger
  if (WHITESPACE.test(query)) return null; // defensive; the scan above already excludes this

  if (insideFencedCode(text, caret)) return null;
  if (insideInlineCode(text, caret)) return null;

  return { start, query };
}
