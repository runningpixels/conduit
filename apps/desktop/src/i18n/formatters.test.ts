import { describe, expect, it } from 'vitest';
import { enTranslate } from '../test/enTranslate';
import {
  collator,
  formatCompact,
  formatCount,
  formatMoney,
  formatSize,
  formatTimeAgo,
  formatTimeAgoTerse,
  type FormatContext,
} from './formatters';
import { EN_MESSAGES, createAppIntl, translate } from './index';
import deMessages from './messages/de.json';

/// D16's claim is that formatting follows the *chosen language*, not the OS.
/// Nothing else in the suite can show that, because every other test renders
/// English on an English machine — where a locale-blind formatter and a
/// correct one produce identical output. These pin both halves: English must
/// not drift, and German must actually differ.

const en: FormatContext = { locale: 'en', t: enTranslate };

const deIntl = createAppIntl('de', deMessages as Record<string, string>);
const de: FormatContext = {
  locale: 'de',
  t: (id, values) => translate(deIntl, id, values),
};

/** A timestamp `minutes` in the past, for the relative formatters. */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe('sizes', () => {
  it('keeps English readable', () => {
    expect(formatSize(512, en)).toBe('512 byte');
    expect(formatSize(4300, en)).toBe('4.2 kB');
    expect(formatSize(2_621_440, en)).toBe('2.5 MB');
  });

  it('gives German its decimal comma', () => {
    // The bug this replaced: `.toFixed(1)` hardcoded `.`, so a German reader
    // saw "2.5 MB" — a number their locale reads as two thousand five hundred.
    expect(formatSize(2_621_440, de)).toBe('2,5 MB');
    expect(formatSize(4300, de)).toBe('4,2 kB');
  });

  it('falls back when the size is unknown', () => {
    expect(formatSize(undefined, en)).toBe('—');
    expect(formatSize(undefined, en, '')).toBe('');
  });
});

describe('relative time', () => {
  it('renders exactly the English the hand-rolled version did', () => {
    // The reason `style: 'narrow'` was chosen: this swap was meant to cost
    // English nothing at all.
    expect(formatTimeAgo(ago(5), en)).toBe('5m ago');
    expect(formatTimeAgo(ago(120), en)).toBe('2h ago');
    expect(formatTimeAgo(ago(60 * 24 * 3), en)).toBe('3d ago');
  });

  it('translates, rather than pretending every language abbreviates like English', () => {
    expect(formatTimeAgo(ago(120), de)).toBe('vor 2 Std.');
  });

  it('reads its words from the catalog, not from a constant', () => {
    expect(formatTimeAgo(undefined, en)).toBe(EN_MESSAGES['common.time.never']);
  });

  it('gives a German reader English for a word German has not been given yet (D5)', () => {
    // `common.time.*` is translated in the wave-1 pass. Until then a German
    // reader sees the English word rather than a raw key — which is exactly
    // what makes shipping a partially translated locale safe. When Phase 5
    // lands, this expectation should flip to the German string, and the fact
    // that it fails is the signal to do so.
    expect(deMessages['common.time.never' as keyof typeof deMessages]).toBeUndefined();
    expect(formatTimeAgo(undefined, de)).toBe(EN_MESSAGES['common.time.never']);
  });
});

describe('terse relative time (the sidebar)', () => {
  it('is unchanged in English', () => {
    expect(formatTimeAgoTerse(ago(5), en)).toBe('5m');
    expect(formatTimeAgoTerse(ago(120), en)).toBe('2h');
    expect(formatTimeAgoTerse(ago(60 * 24 * 3), en)).toBe('3d');
    expect(formatTimeAgoTerse(ago(0), en)).toBe('now');
  });

  it('floors rather than rounds, so 90 minutes is not "2h"', () => {
    expect(formatTimeAgoTerse(ago(90), en)).toBe('1h');
  });

  it('hands over to a date after a week, rather than counting days forever', () => {
    // "412d" tells a reader nothing about a conversation from last year.
    const old = new Date(Date.now() - 400 * 24 * 60 * 60_000).toISOString();
    expect(formatTimeAgoTerse(old, en)).not.toMatch(/d$/);
  });

  it('echoes an unparseable timestamp instead of guessing', () => {
    expect(formatTimeAgoTerse('not-a-date', en)).toBe('not-a-date');
  });
});

describe('numbers', () => {
  it('groups digits the way each locale does', () => {
    expect(formatCount(1234567, en)).toBe('1,234,567');
    expect(formatCount(1234567, de)).toBe('1.234.567');
  });

  it('abbreviates a context window', () => {
    expect(formatCompact(200_000, en)).toBe('200K');
    expect(formatCompact(1_000_000, en)).toBe('1M');
  });

  it('formats money with the locale, and the currency without it', () => {
    // Providers bill in USD wherever the reader lives, so the currency is
    // fixed and only its presentation moves.
    expect(formatMoney(1234, en)).toBe('$12.34');
    expect(formatMoney(1234, de)).toContain('12,34');
  });
});

describe('collation', () => {
  it('sorts accented letters with their base letter', () => {
    // A bare `.localeCompare()` with no locale puts "Ärger" after "Zebra" in
    // some environments, which reads as a broken list rather than a sort.
    const names = ['Zebra', 'Ärger', 'apple', 'Öl'];
    expect([...names].sort(collator('de').compare)).toEqual(['apple', 'Ärger', 'Öl', 'Zebra']);
  });

  it('returns the same instance for a locale, so lists do not rebuild it per row', () => {
    expect(collator('en')).toBe(collator('en'));
  });
});

describe('the catalog backs all of it', () => {
  it('defines every word the formatters reach for', () => {
    for (const key of [
      'common.time.never',
      'common.time.justNow',
      'common.time.now',
      'common.time.today',
      'common.time.yesterday',
      'common.time.earlier',
    ]) {
      expect(EN_MESSAGES[key], `${key} is missing from en.json`).toBeTruthy();
    }
  });
});
