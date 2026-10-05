import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_DAILY_SPEND_ALERT_USD,
  parseSpendAlertInput,
  readSpendAlertMark,
  resetSpendAlertMemoryForTests,
  shouldShowSpendAlert,
  spendAlertInputValue,
  spendAlertPending,
  usageDay,
  writeSpendAlertMark,
} from './spendAlert';

describe('parseSpendAlertInput', () => {
  it('reads empty as off', () => {
    expect(parseSpendAlertInput('')).toBeNull();
    expect(parseSpendAlertInput('   ')).toBeNull();
    expect(parseSpendAlertInput('$')).toBeNull();
  });

  it('accepts plain amounts, a leading $, and a decimal comma', () => {
    expect(parseSpendAlertInput('10')).toBe(10);
    expect(parseSpendAlertInput(' 12.50 ')).toBe(12.5);
    expect(parseSpendAlertInput('$5')).toBe(5);
    expect(parseSpendAlertInput('$ 7.25')).toBe(7.25);
    expect(parseSpendAlertInput('12,5')).toBe(12.5);
    expect(parseSpendAlertInput('0.01')).toBe(0.01);
    expect(parseSpendAlertInput(String(MAX_DAILY_SPEND_ALERT_USD))).toBe(MAX_DAILY_SPEND_ALERT_USD);
  });

  it('takes at most two decimals, so digit grouping is never misread', () => {
    expect(parseSpendAlertInput('2.3')).toBe(2.3);
    expect(parseSpendAlertInput('2.34')).toBe(2.34);
    expect(parseSpendAlertInput('2.345')).toBe('invalid');
    expect(parseSpendAlertInput('1.000')).toBe('invalid');
    expect(parseSpendAlertInput('1,000')).toBe('invalid');
  });

  it('refuses zero, negatives, too much, and anything that is not an amount', () => {
    for (const bad of [
      '0',
      '0.00',
      '0.004',
      '0.001',
      '-5',
      '100000.01',
      '1e3',
      'abc',
      '10$',
      '1,000',
      '1.000,50',
      '10.',
      '.5',
      'Infinity',
      'NaN',
    ]) {
      expect(parseSpendAlertInput(bad), bad).toBe('invalid');
    }
  });

  it('shows the saved amount, or nothing when off', () => {
    expect(spendAlertInputValue(12.5)).toBe('12.5');
    expect(spendAlertInputValue(null)).toBe('');
    expect(spendAlertInputValue(undefined)).toBe('');
  });
});

describe('usageDay', () => {
  it('is the UTC date the usage summary buckets by', () => {
    expect(usageDay(new Date('2026-10-05T23:30:00Z'))).toBe('2026-10-05');
    expect(usageDay(new Date('2026-10-06T00:10:00Z'))).toBe('2026-10-06');
  });
});

describe('shouldShowSpendAlert', () => {
  const day = '2026-10-05';

  it('stays quiet while the alert is off', () => {
    for (const thresholdUsd of [null, undefined, 0, -1, Number.NaN]) {
      expect(shouldShowSpendAlert({ thresholdUsd, todayCostCents: 1e9, day, last: null })).toBe(false);
    }
  });

  it('fires once spend passes the threshold, not at or below it', () => {
    expect(shouldShowSpendAlert({ thresholdUsd: 10, todayCostCents: 999, day, last: null })).toBe(false);
    expect(shouldShowSpendAlert({ thresholdUsd: 10, todayCostCents: 1000, day, last: null })).toBe(false);
    expect(shouldShowSpendAlert({ thresholdUsd: 10, todayCostCents: 1000.01, day, last: null })).toBe(true);
    expect(shouldShowSpendAlert({ thresholdUsd: 0.5, todayCostCents: 51, day, last: null })).toBe(true);
  });

  it('ignores a cost that is not a number', () => {
    expect(
      shouldShowSpendAlert({ thresholdUsd: 10, todayCostCents: Number.NaN, day, last: null }),
    ).toBe(false);
  });

  it('fires once a day, not on every turn after', () => {
    const last = { day, thresholdUsd: 10 };
    expect(shouldShowSpendAlert({ thresholdUsd: 10, todayCostCents: 5000, day, last })).toBe(false);
    // A new day arms it again.
    expect(
      shouldShowSpendAlert({ thresholdUsd: 10, todayCostCents: 5000, day: '2026-10-06', last }),
    ).toBe(true);
  });

  it('re-arms the same day only for a higher threshold', () => {
    const last = { day, thresholdUsd: 10 };
    expect(shouldShowSpendAlert({ thresholdUsd: 20, todayCostCents: 1500, day, last })).toBe(false);
    expect(shouldShowSpendAlert({ thresholdUsd: 20, todayCostCents: 2500, day, last })).toBe(true);
    // Lowering it: the user already knows spend is past the higher line.
    expect(shouldShowSpendAlert({ thresholdUsd: 5, todayCostCents: 2500, day, last })).toBe(false);
  });
});

describe('spendAlertPending', () => {
  it('skips the usage read once today is already alerted', () => {
    const day = '2026-10-05';
    expect(spendAlertPending(null, day, null)).toBe(false);
    expect(spendAlertPending(10, day, null)).toBe(true);
    expect(spendAlertPending(10, day, { day, thresholdUsd: 10 })).toBe(false);
    expect(spendAlertPending(10, '2026-10-06', { day, thresholdUsd: 10 })).toBe(true);
    expect(spendAlertPending(15, day, { day, thresholdUsd: 10 })).toBe(true);
  });
});

describe('spend alert mark', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSpendAlertMemoryForTests();
  });

  it('round-trips through storage', () => {
    expect(readSpendAlertMark()).toBeNull();
    writeSpendAlertMark({ day: '2026-10-05', thresholdUsd: 10 });
    expect(readSpendAlertMark()).toEqual({ day: '2026-10-05', thresholdUsd: 10 });
  });

  it('ignores a corrupt stored value', () => {
    localStorage.setItem('conduit:spend-alert-last', '{not json');
    expect(readSpendAlertMark()).toBeNull();
    localStorage.setItem('conduit:spend-alert-last', JSON.stringify({ day: 5 }));
    expect(readSpendAlertMark()).toBeNull();
  });
});
