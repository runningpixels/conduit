/**
 * The composer's `/` tools trigger — a pure function, like `findHashTrigger`,
 * so its rules can be unit-tested without mounting the composer.
 *
 * It opens only on a `/` as the very first character of the message, and the
 * query runs from there to the caret with no whitespace in it. Anywhere else a
 * `/` is ordinary text (a path, a fraction, "and/or"), and once a space follows
 * the command word the trigger is gone, so "/usr/bin is…" types normally.
 */

export interface SlashTrigger {
  /** Text between the `/` and the caret — never contains whitespace. */
  query: string;
  /** End of the command word (the first whitespace after the `/`, or the end
   *  of the text): what a pick removes. */
  end: number;
}

const WHITESPACE = /\s/;

export function findSlashTrigger(text: string, caret: number): SlashTrigger | null {
  if (caret < 1 || caret > text.length) return null;
  if (text[0] !== '/') return null;
  const query = text.slice(1, caret);
  if (WHITESPACE.test(query)) return null;
  let end = caret;
  while (end < text.length && !WHITESPACE.test(text[end])) end++;
  return { query, end };
}

/** `text` with the command word (and one space after it) removed. */
export function removeSlashCommand(text: string, trigger: SlashTrigger): string {
  const rest = text.slice(trigger.end);
  return rest.startsWith(' ') ? rest.slice(1) : rest;
}

/** The composer tools a `/` command can run. */
export type SlashCommandId = 'web' | 'research' | 'folder' | 'file' | 'skill';

/** Display order of the `/` menu. The ids double as the typed command word. */
export const SLASH_COMMAND_IDS: readonly SlashCommandId[] = ['web', 'research', 'folder', 'file', 'skill'];

/** Whether a command matches what follows the `/`: the start of its word, or
 *  of a word in its (translated) description, so a reader typing in their own
 *  language finds it. Word starts only: "/sk" means skill, not "Ask". */
export function slashCommandMatches(id: SlashCommandId, label: string, query: string): boolean {
  const q = query.toLowerCase();
  return id.startsWith(q) || label.toLowerCase().split(/\s+/).some((word) => word.startsWith(q));
}
