/**
 * Daily spend alert: the pure parts.
 *
 * The threshold lives in `AppSettings.dailySpendAlertUsd` (US dollars, `null`
 * or absent = off). After a chat turn ends, App reads today's usage summary —
 * the same `getUsageSummary('today')` the Usage & Cost section shows — and, if
 * the estimate has passed the threshold, shows one toast. Nothing here blocks
 * or cancels a turn; the alert is a notice, never a limit.
 *
 * "Today" is the summary's day: usage rows are stamped and bucketed in UTC by
 * the backend (`usage_summary::period_start`), so the day key used to remember
 * "already alerted" is the UTC date too. Using the local date here would let
 * the two disagree for part of every day.
 */

/** Mirrors `MAX_DAILY_SPEND_ALERT_USD` in `provider-core` (a typo guard). */
export const MAX_DAILY_SPEND_ALERT_USD = 100_000;

/**
 * Parse the settings field. Empty means off (`null`); anything that is not a
 * plain amount from $0.01 to the maximum, with at most two decimals, is
 * `'invalid'`. Accepts a leading `$` and a decimal comma (`12,50`). Digit
 * grouping (`1,000` or `1.000`) is refused rather than guessed at: with either
 * separator allowed as the decimal point, it would silently read as 1.
 */
export function parseSpendAlertInput(raw: string): number | null | 'invalid' {
  let text = raw.trim();
  if (text.startsWith('$')) text = text.slice(1).trim();
  if (text === '') return null;
  if (!/^\d+([.,]\d{1,2})?$/.test(text)) return 'invalid';
  const value = Number(text.replace(',', '.'));
  if (!Number.isFinite(value)) return 'invalid';
  const usd = Math.round(value * 100) / 100;
  if (usd <= 0 || usd > MAX_DAILY_SPEND_ALERT_USD) return 'invalid';
  return usd;
}

/** The text the field starts from: the saved amount, or empty when off. */
export function spendAlertInputValue(usd: number | null | undefined): string {
  return usd == null ? '' : String(usd);
}

/** The usage summary's "today", as `YYYY-MM-DD` (UTC — see the module doc). */
export function usageDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The last alert shown: on which day, and for which threshold. */
export interface SpendAlertMark {
  day: string;
  thresholdUsd: number;
}

function isActive(thresholdUsd: number | null | undefined): thresholdUsd is number {
  return typeof thresholdUsd === 'number' && Number.isFinite(thresholdUsd) && thresholdUsd > 0;
}

/**
 * Whether today's spend still needs looking at. False when the alert is off,
 * or it has already fired today for this threshold or a higher one — so a day
 * of turns after the alert costs no further reads.
 */
export function spendAlertPending(
  thresholdUsd: number | null | undefined,
  day: string,
  last: SpendAlertMark | null,
): boolean {
  if (!isActive(thresholdUsd)) return false;
  return !(last && last.day === day && last.thresholdUsd >= thresholdUsd);
}

/**
 * Whether to show the alert now: the alert is on, today's estimated cost has
 * passed the threshold, and it has not already fired today for this line.
 *
 * Raising the threshold the same day arms it again, since the new line has not
 * been crossed yet; lowering it does not, because the user has already been
 * told spend is above the higher amount.
 */
export function shouldShowSpendAlert(input: {
  thresholdUsd: number | null | undefined;
  todayCostCents: number;
  day: string;
  last: SpendAlertMark | null;
}): boolean {
  const { thresholdUsd, todayCostCents, day, last } = input;
  if (!spendAlertPending(thresholdUsd, day, last)) return false;
  if (!Number.isFinite(todayCostCents)) return false;
  return todayCostCents > (thresholdUsd as number) * 100;
}

const STORAGE_KEY = 'conduit:spend-alert-last';

/** In-memory copy, so the once-a-day rule holds even when storage is unavailable. */
let memoryMark: SpendAlertMark | null = null;

/** The last alert shown, from this session or (via localStorage) an earlier one. */
export function readSpendAlertMark(): SpendAlertMark | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SpendAlertMark>;
      if (typeof parsed.day === 'string' && typeof parsed.thresholdUsd === 'number') {
        return { day: parsed.day, thresholdUsd: parsed.thresholdUsd };
      }
    }
  } catch {
    /* storage unavailable or corrupt: fall back to this session's memory */
  }
  return memoryMark;
}

export function writeSpendAlertMark(mark: SpendAlertMark): void {
  memoryMark = mark;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(mark));
  } catch {
    /* storage unavailable: the in-memory mark still holds for this session */
  }
}

/** Test seam: forget the in-memory mark. */
export function resetSpendAlertMemoryForTests(): void {
  memoryMark = null;
}
