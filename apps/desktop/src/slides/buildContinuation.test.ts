import { describe, expect, it } from 'vitest';
import {
  deckContinuationMessage,
  deckTurnEnd,
  missingStorylineLines,
  type DeckBuildPhase,
  type DeckTurnEnd,
} from './buildContinuation';

const storyline = ['Intro', 'Problem', 'Plan', 'Pricing', 'Next steps'].map((text, i) => ({ id: `l${i}`, text }));
const format = (lines: string) => `missing: ${lines}`;

const decide = (
  over: Partial<{
    phase: DeckBuildPhase | null;
    stage: 'storyline' | 'slides';
    slideCount: number;
    turnEnd: DeckTurnEnd;
  }> = {},
) =>
  deckContinuationMessage(
    { phase: 'build', stage: 'slides', storyline, slideCount: 3, turnEnd: 'completed', ...over },
    format,
  );

describe('missingStorylineLines', () => {
  it('numbers the lines past the last slide as the user sees them', () => {
    expect(missingStorylineLines(storyline, 3)).toBe('4. Pricing, 5. Next steps');
    expect(missingStorylineLines(storyline, 0)).toBe('1. Intro, 2. Problem, 3. Plan, 4. Pricing, 5. Next steps');
    expect(missingStorylineLines(storyline, 5)).toBe('');
  });
});

describe('deckTurnEnd', () => {
  it('tells a stop, a time limit, another error and a normal end apart', () => {
    expect(deckTurnEnd({ interrupted: true })).toBe('stopped');
    expect(deckTurnEnd({ interrupted: true, error: 'x', errorCode: 'turn_time_limit' })).toBe('stopped');
    expect(deckTurnEnd({ interrupted: false, error: 'x', errorCode: 'turn_time_limit' })).toBe('time-limit');
    expect(deckTurnEnd({ interrupted: false, error: 'x', errorCode: 'turn_time_limit_building' })).toBe('time-limit');
    expect(deckTurnEnd({ interrupted: false, error: 'boom', errorCode: 'provider_error' })).toBe('failed');
    expect(deckTurnEnd({ interrupted: false })).toBe('completed');
  });
});

describe('deckContinuationMessage', () => {
  it('continues a build that ended short, naming the missing lines', () => {
    expect(decide()).toBe('missing: 4. Pricing, 5. Next steps');
  });

  it('counts a turn that hit the time limit as short', () => {
    expect(decide({ turnEnd: 'time-limit', slideCount: 1 })).toBe(
      'missing: 2. Problem, 3. Plan, 4. Pricing, 5. Next steps',
    );
  });

  it('does nothing when every line has a slide', () => {
    expect(decide({ slideCount: 5 })).toBeNull();
    expect(decide({ slideCount: 6 })).toBeNull();
  });

  it('does nothing when the user stopped the turn or it failed', () => {
    expect(decide({ turnEnd: 'stopped' })).toBeNull();
    expect(decide({ turnEnd: 'failed' })).toBeNull();
  });

  it('fires once: not for the continuation turn, nor for an ordinary edit turn', () => {
    expect(decide({ phase: 'continuation' })).toBeNull();
    expect(decide({ phase: null })).toBeNull();
  });

  it('does nothing outside the slides stage', () => {
    expect(decide({ stage: 'storyline' })).toBeNull();
  });
});
