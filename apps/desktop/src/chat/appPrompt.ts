/// Messages the app sends on the user's behalf (Slides: "Build slides", the
/// storyline request after a chat becomes a deck, "Ask to fix" on an
/// overflowing slide). They go to the model as ordinary user turns, but the
/// thread shows them as a short app note rather than as something the user
/// typed.
///
/// The marker is U+2063 INVISIBLE SEPARATOR at the very start, followed by a
/// one-line label for the thread, a newline, then the text the model reads.
/// It survives the database round trip, so reloaded chats render the same
/// way, and it costs the model nothing.

export const APP_PROMPT_MARK = '⁣';

/** Build an app-sent message: `label` is what the thread shows. */
export function appPrompt(label: string, text: string): string {
  return `${APP_PROMPT_MARK}${label.replace(/\s+/g, ' ').trim()}\n${text}`;
}

/** The thread label of an app-sent message, or null for a typed one. */
export function appPromptLabel(content: string): string | null {
  if (!content.startsWith(APP_PROMPT_MARK)) return null;
  const end = content.indexOf('\n');
  const label = (end === -1 ? content.slice(1) : content.slice(1, end)).trim();
  return label === '' ? null : label;
}
