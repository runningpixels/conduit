import { describe, expect, it } from 'vitest';
import {
  getContextWindow,
  mergeProviderUsage,
  sumUsageCostCents,
  sumUsageTokens,
} from './contextWindows';

describe('contextWindows', () => {
  it('returns known context windows and null for unknown models', () => {
    expect(getContextWindow('claude-sonnet-4')).toBe(200000);
    expect(getContextWindow('gpt-4.1')).toBe(1000000);
    expect(getContextWindow('not-a-model')).toBeNull();
    expect(getContextWindow('')).toBeNull();
  });

  it('sums tokens including cache read/write', () => {
    const total = sumUsageTokens({
      inputTokens: 1000n,
      outputTokens: 2000n,
      cacheReadTokens: 3000n,
      cacheWriteTokens: 400n,
    });
    expect(total).toBe(6400);
  });

  it('falls back to legacy cacheTokens when split fields are absent', () => {
    expect(
      sumUsageTokens({ inputTokens: 100n, outputTokens: 200n, cacheTokens: 50n }),
    ).toBe(350);
    // legacy cacheTokens must not double-count when split fields exist
    expect(
      sumUsageTokens({
        inputTokens: 100n,
        cacheTokens: 5000n,
        cacheReadTokens: 50n,
      }),
    ).toBe(150);
  });

  it('treats null usage and null token fields as zero', () => {
    expect(sumUsageTokens(null)).toBe(0);
    expect(sumUsageTokens(undefined)).toBe(0);
    expect(
      sumUsageTokens({
        inputTokens: null as unknown as bigint,
        outputTokens: null as unknown as bigint,
        cacheTokens: null as unknown as bigint,
      }),
    ).toBe(0);
  });

  it('delegates cost estimation to the cost table', () => {
    const cost = sumUsageCostCents(
      { inputTokens: 100000n, outputTokens: 10000n },
      'claude-sonnet-4',
    );
    expect(cost).toBeCloseTo(45, 6);
    expect(sumUsageCostCents({ inputTokens: 10n }, 'unknown-model')).toBeNull();
  });

  it('merges usage records by summing tokens and keeping the later costHint', () => {
    const merged = mergeProviderUsage(
      { inputTokens: 100n, outputTokens: 50n, costHint: '$0.001' },
      { inputTokens: 200n, cacheReadTokens: 30n, costHint: '$0.002' },
    );
    expect(merged?.inputTokens).toBe(300n);
    expect(merged?.outputTokens).toBe(50n);
    expect(merged?.cacheReadTokens).toBe(30n);
    expect(merged?.costHint).toBe('$0.002');
  });

  it('merge handles null sides and null fields', () => {
    expect(mergeProviderUsage(null, { inputTokens: 10n })).toEqual({
      inputTokens: 10n,
    });
    expect(mergeProviderUsage({ outputTokens: 5n }, null)?.outputTokens).toBe(5n);
    expect(
      mergeProviderUsage(
        { inputTokens: null as unknown as bigint },
        { outputTokens: 7n },
      )?.outputTokens,
    ).toBe(7n);
    expect(mergeProviderUsage(null, null)).toBeNull();
  });
});
