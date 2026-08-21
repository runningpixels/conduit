import { describe, expect, it } from 'vitest';
import { conversationGroup, dayRuleLabel, sameCalendarDay } from './dayGroup';

const NOW = new Date('2026-08-03T12:00:00');

describe('conversationGroup', () => {
  it('buckets by relative day, then month, then year', () => {
    expect(conversationGroup('2026-08-03T09:00:00', NOW)).toBe('Today');
    expect(conversationGroup('2026-08-02T23:59:00', NOW)).toBe('Yesterday');
    expect(conversationGroup('2026-07-14T09:00:00', NOW)).toBe('July');
    expect(conversationGroup('2025-11-02T09:00:00', NOW)).toBe('2025');
  });

  it('degrades rather than throwing on an unparseable date', () => {
    expect(conversationGroup('not-a-date', NOW)).toBe('Earlier');
  });
});

describe('sameCalendarDay', () => {
  it('is true across a day, false across midnight', () => {
    expect(sameCalendarDay('2026-08-03T00:01:00', '2026-08-03T23:59:00')).toBe(true);
    expect(sameCalendarDay('2026-08-02T23:59:00', '2026-08-03T00:01:00')).toBe(false);
  });

  it('separates the same day-of-month in different months and years', () => {
    expect(sameCalendarDay('2026-07-03T12:00:00', '2026-08-03T12:00:00')).toBe(false);
    expect(sameCalendarDay('2025-08-03T12:00:00', '2026-08-03T12:00:00')).toBe(false);
  });

  /**
   * The separator is only drawn where this returns false, so an unparseable
   * timestamp must claim "same day" — a wrong rule is worse than none, and a
   * thread of malformed dates would otherwise get a separator above every turn.
   */
  it('claims the same day when either timestamp is unusable', () => {
    expect(sameCalendarDay('nonsense', '2026-08-03T12:00:00')).toBe(true);
    expect(sameCalendarDay('2026-08-03T12:00:00', '')).toBe(true);
  });
});

describe('dayRuleLabel', () => {
  it('keeps the relative words while they are unambiguous', () => {
    expect(dayRuleLabel('2026-08-03T09:00:00', NOW)).toBe('Today');
    expect(dayRuleLabel('2026-08-02T09:00:00', NOW)).toBe('Yesterday');
  });

  /**
   * Past yesterday it goes absolute. `conversationGroup` collapses a whole
   * month into one word, which is the right label for a sidebar bucket and the
   * wrong one for a boundary *inside* that month — every separator in August
   * would read "August" and say nothing about which day changed.
   */
  it('uses a dated label once a month label would be ambiguous', () => {
    expect(dayRuleLabel('2026-08-01T09:00:00', NOW)).not.toBe('August');
    expect(dayRuleLabel('2026-08-01T09:00:00', NOW)).toMatch(/Aug/);
  });

  it('adds the year only when it differs from now', () => {
    expect(dayRuleLabel('2026-07-14T09:00:00', NOW)).not.toMatch(/2026/);
    expect(dayRuleLabel('2025-11-02T09:00:00', NOW)).toMatch(/2025/);
  });
});
