import type { DeckStage, StorylineItem } from '../ipc/contracts';

/// A deck build that stops short is picked up once, automatically. A weak model
/// builds in small batches and ends its turn with text ("Building the rest
/// now") after four of twelve slides, and a slow one runs into the turn time
/// limit; either way the user is left with a half-built deck and has to know to
/// ask again. One continuation turn names the lines that still have no slide.
/// Only one, so a model that cannot finish does not loop: the user sees the
/// deck as it is.

/** Where a deck chat is in an app-driven build. `build` is the turn started by
 *  "Build slides"; `continuation` is the one automatic follow-up. */
export type DeckBuildPhase = 'build' | 'continuation';

/** How a turn ended, as far as a build cares. */
export type DeckTurnEnd = 'completed' | 'time-limit' | 'stopped' | 'failed';

/** The error codes Rust ends a turn with at its time limit. */
const TIME_LIMIT_CODES = new Set(['turn_time_limit', 'turn_time_limit_building']);

export function deckTurnEnd(state: { error?: string; errorCode?: string; interrupted: boolean }): DeckTurnEnd {
  if (state.interrupted) return 'stopped';
  if (state.errorCode && TIME_LIMIT_CODES.has(state.errorCode)) return 'time-limit';
  if (state.error) return 'failed';
  return 'completed';
}

/** The storyline lines past the last slide, numbered the way the user sees
 *  them: "9. Pricing, 10. Next steps". Empty when every line has a slide. */
export function missingStorylineLines(storyline: StorylineItem[], slideCount: number): string {
  return storyline
    .map((item, index) => ({ number: index + 1, text: item.text.replace(/\s+/g, ' ').trim() }))
    .slice(slideCount)
    .map((line) => `${line.number}. ${line.text}`)
    .join(', ');
}

/**
 * The text of the continuation turn, or null when none should be sent: the
 * turn was not a first build (an edit turn, or the continuation itself), the
 * user stopped it, it failed for a reason another turn would only repeat, the
 * deck is not in the slides stage, or every storyline line has a slide. A turn
 * that hit its time limit counts as short: that is the main case.
 *
 * `format` wraps the missing lines in the catalog message.
 */
export function deckContinuationMessage(
  input: {
    phase: DeckBuildPhase | null;
    stage: DeckStage;
    storyline: StorylineItem[];
    slideCount: number;
    turnEnd: DeckTurnEnd;
  },
  format: (lines: string) => string,
): string | null {
  if (input.phase !== 'build') return null;
  if (input.stage !== 'slides') return null;
  if (input.turnEnd !== 'completed' && input.turnEnd !== 'time-limit') return null;
  if (input.slideCount >= input.storyline.length) return null;
  return format(missingStorylineLines(input.storyline, input.slideCount));
}
