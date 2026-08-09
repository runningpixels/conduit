import { describe, expect, it } from 'vitest';
import {
  estimateCostCents,
  formatCostCents,
  formatModelPriceLabel,
  getModelPrices,
  toTokenNumber,
} from './costTable';

describe('costTable', () => {
  it('returns prices for known models', () => {
    const sonnet = getModelPrices('claude-sonnet-4');
    expect(sonnet).toEqual({
      inputPerMtokCents: 300,
      outputPerMtokCents: 1500,
      cacheReadPerMtokCents: 30,
    });
    expect(getModelPrices('gpt-4.1-mini')?.inputPerMtokCents).toBe(40);
  });

  it('returns null for unknown or empty model ids', () => {
    expect(getModelPrices('unknown-model')).toBeNull();
    expect(getModelPrices('')).toBeNull();
  });

  it('estimates cost from bigint token fields', () => {
    // 100k input + 10k output on sonnet-4:
    // 0.1 * 300 + 0.01 * 1500 = 30 + 15 = 45 cents
    const cost = estimateCostCents(
      { inputTokens: 100000n, outputTokens: 10000n },
      'claude-sonnet-4',
    );
    expect(cost).toBeCloseTo(45, 6);
  });

  it('prices cache-read tokens at the cache-read rate and cache-write at output rate', () => {
    // 1M cache-read = 30 cents; 1M cache-write = 1500 cents on sonnet-4
    const cost = estimateCostCents(
      { cacheReadTokens: 1000000n, cacheWriteTokens: 1000000n },
      'claude-sonnet-4',
    );
    expect(cost).toBeCloseTo(1530, 6);
  });

  it('returns null for unknown models even when usage exists', () => {
    expect(
      estimateCostCents({ inputTokens: 1000n }, 'internal-llama'),
    ).toBeNull();
    expect(estimateCostCents(null, 'claude-sonnet-4')).toBeNull();
    expect(estimateCostCents(undefined, 'claude-sonnet-4')).toBeNull();
  });

  it('handles null token fields (IPC bridge sends null for Rust None)', () => {
    const cost = estimateCostCents(
      {
        inputTokens: null as unknown as bigint,
        outputTokens: 10000n,
        cacheReadTokens: null as unknown as bigint,
        cacheWriteTokens: null as unknown as bigint,
      },
      'claude-sonnet-4',
    );
    expect(cost).toBeCloseTo(15, 6);
  });

  it('formats cents as USD with 4 significant decimals for sub-cent costs', () => {
    expect(formatCostCents(1.44)).toBe('$0.0144');
    expect(formatCostCents(5)).toBe('$0.05');
    expect(formatCostCents(100)).toBe('$1.00');
    expect(formatCostCents(0.3)).toBe('$0.003');
    expect(formatCostCents(1234.5)).toBe('$12.35');
  });

  it('formats a per-Mtok price tail, trimming trailing zeros', () => {
    expect(formatModelPriceLabel('claude-sonnet-4')).toBe('$3 / $15');
    expect(formatModelPriceLabel('claude-opus-4')).toBe('$15 / $75');
    // 40 / 160 cents per Mtok — the fractional case that must not read
    // "$0.40 / $1.60" beside whole-dollar rows in the same menu.
    expect(formatModelPriceLabel('gpt-4.1-mini')).toBe('$0.4 / $1.6');
    expect(formatModelPriceLabel('gpt-4o-mini')).toBe('$0.15 / $0.6');
  });

  it('returns null for a model with no bundled price', () => {
    // The caller falls back to a posture word from the descriptor rather than
    // inventing a number.
    expect(formatModelPriceLabel('internal-llama')).toBeNull();
    expect(formatModelPriceLabel('')).toBeNull();
  });

  it('converts null/bigint token values to safe numbers', () => {
    expect(toTokenNumber(10n)).toBe(10);
    expect(toTokenNumber(10)).toBe(10);
    expect(toTokenNumber(null)).toBe(0);
    expect(toTokenNumber(undefined)).toBe(0);
  });
});
