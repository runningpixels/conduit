/**
 * Dictation helpers for the composer's microphone button. The recording and
 * the provider call happen in Rust (`commands/dictation.rs`); this file only
 * decides where the text lands.
 */

/** Providers that can turn speech into text, as `TRANSCRIPTION_PROVIDERS` in
 *  provider-core lists them. Used where the status call is not worth making
 *  (onboarding's hint). */
export const TRANSCRIPTION_PROVIDER_IDS: readonly string[] = ['openai', 'openrouter', 'groq'];

/** Scripts written without spaces between words. Hangul uses spaces. */
const NO_SPACES = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}　-〿＀-￯]/u;

/**
 * `text` inserted into `value` over the selection `start`..`end`, with a space
 * on either side where words would otherwise run together. Returns the new
 * value and where the caret goes (just after the inserted text).
 */
export function insertDictation(
  value: string,
  start: number,
  end: number,
  text: string,
): { value: string; caret: number } {
  const piece = text.trim();
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  if (!piece) return { value, caret: to };
  const before = value.slice(0, from);
  const after = value.slice(to);
  const needsSpace = (a: string, b: string) => a !== '' && b !== '' && !/\s/.test(a) && !/\s/.test(b) && !NO_SPACES.test(a) && !NO_SPACES.test(b);
  const lead = needsSpace(before.slice(-1), piece[0]) ? ' ' : '';
  const trail = needsSpace(piece.slice(-1), after[0] ?? '') ? ' ' : '';
  const head = before + lead + piece;
  return { value: head + trail + after, caret: head.length };
}

/** Seconds as m:ss. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
