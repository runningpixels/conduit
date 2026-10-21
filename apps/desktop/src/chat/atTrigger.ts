/**
 * The `@` agent trigger: `@Researcher compare these` sends the message to that
 * agent. A pure function modelled on `hashTrigger.ts` — the trigger opens on an
 * `@` at the start of the text or right after whitespace, and the query runs
 * from there to the caret with no whitespace in it. The same rule keeps
 * `me@example.com` inert: the run ending at the caret starts with `me`, not `@`.
 */

export interface AtTrigger {
  /** Index of the `@` character itself. */
  start: number;
  /** Text between the `@` and the caret — never contains whitespace. */
  query: string;
}

const WHITESPACE = /\s/;

function insideFencedCode(text: string, caret: number): boolean {
  const fences = text.slice(0, caret).match(/```/g);
  return (fences?.length ?? 0) % 2 === 1;
}

function insideInlineCode(text: string, caret: number): boolean {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const backticks = text.slice(lineStart, caret).match(/`/g);
  return (backticks?.length ?? 0) % 2 === 1;
}

/** Find the active `@` trigger for `text` with the caret at `caret`, if any.
 *  Inert inside code, mid-word, in an email address, and on `@@`. */
export function findAtTrigger(text: string, caret: number): AtTrigger | null {
  if (caret < 0 || caret > text.length) return null;

  let i = caret;
  while (i > 0 && !WHITESPACE.test(text[i - 1])) i--;
  const start = i;

  if (start >= caret) return null;
  if (text[start] !== '@') return null;

  const query = text.slice(start + 1, caret);
  if (query.startsWith('@')) return null;

  if (insideFencedCode(text, caret)) return null;
  if (insideInlineCode(text, caret)) return null;

  return { start, query };
}
