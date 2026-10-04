import { describe, expect, it } from 'vitest';
import type { ModelPrice } from '@conduit/config-schema';
import {
  estimateCostCents,
  formatCostCents,
  formatModelPriceLabel,
  inputIncludesCacheReads,
  toTokenNumber,
} from './costTable';

const sonnet: ModelPrice = { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 };

// These cases mirror `pricing::tests` in crates/provider-core: the renderer's
// status line and the backend's usage tables must agree to the cent.
describe('costTable', () => {
  it('computes cost in real cents', () => {
    // 1M input + 1M output at $3 / $15 = $18 = 1,800 cents.
    const cost = estimateCostCents({ inputTokens: 1_000_000n, outputTokens: 1_000_000n }, 'anthropic', {
      inputPerMtok: 3,
      outputPerMtok: 15,
    });
    expect(cost).toBeCloseTo(1800, 6);
  });

  it('does not bill cache reads twice on providers that count them as input', () => {
    const price: ModelPrice = { inputPerMtok: 2, outputPerMtok: 10, cacheReadPerMtok: 0.2, cacheWritePerMtok: 2.5 };
    // OpenAI-style: 1M input of which 800k were cache hits.
    // 200k uncached at $2 + 800k cached at $0.20 = $0.40 + $0.16 = 56 cents.
    expect(estimateCostCents({ inputTokens: 1_000_000n, cacheReadTokens: 800_000n }, 'openai', price)).toBeCloseTo(56, 6);
    // Anthropic reports input without cache reads: nothing is subtracted.
    // $0.40 + $0.16 + 100k writes at $2.50 = 81 cents.
    expect(
      estimateCostCents(
        { inputTokens: 200_000n, cacheReadTokens: 800_000n, cacheWriteTokens: 100_000n },
        'anthropic',
        price,
      ),
    ).toBeCloseTo(81, 6);
  });

  it('charges cache tokens at the input price when no cache price is published', () => {
    const cost = estimateCostCents({ cacheReadTokens: 1_000_000n, cacheWriteTokens: 1_000_000n }, 'anthropic', {
      inputPerMtok: 1,
      outputPerMtok: 1,
    });
    expect(cost).toBeCloseTo(200, 6);
  });

  it('knows which providers fold cache reads into input', () => {
    expect(inputIncludesCacheReads('anthropic')).toBe(false);
    for (const id of ['openai', 'gemini', 'openrouter', 'deepseek', 'zai']) {
      expect(inputIncludesCacheReads(id)).toBe(true);
    }
  });

  it('returns null without usage or without a price -- unpriced is not free', () => {
    expect(estimateCostCents({ inputTokens: 1000n }, 'openai_compat', null)).toBeNull();
    expect(estimateCostCents({ inputTokens: 1000n }, 'openai_compat', undefined)).toBeNull();
    expect(estimateCostCents(null, 'anthropic', sonnet)).toBeNull();
    expect(estimateCostCents(undefined, 'anthropic', sonnet)).toBeNull();
  });

  it('handles null token fields (IPC bridge sends null for Rust None)', () => {
    const cost = estimateCostCents(
      {
        inputTokens: null as unknown as bigint,
        outputTokens: 10000n,
        cacheReadTokens: null as unknown as bigint,
        cacheWriteTokens: null as unknown as bigint,
      },
      'anthropic',
      sonnet,
    );
    // 10k output at $15 / Mtok = $0.15 = 15 cents.
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
    expect(formatModelPriceLabel(sonnet)).toBe('$3 / $15');
    expect(formatModelPriceLabel({ inputPerMtok: 15, outputPerMtok: 75 })).toBe('$15 / $75');
    // The fractional case that must not read "$0.40 / $1.60" beside
    // whole-dollar rows in the same menu.
    expect(formatModelPriceLabel({ inputPerMtok: 0.4, outputPerMtok: 1.6 })).toBe('$0.4 / $1.6');
    expect(formatModelPriceLabel({ inputPerMtok: 0.15, outputPerMtok: 0.6 })).toBe('$0.15 / $0.6');
    // Sub-dime prices keep a third decimal.
    expect(formatModelPriceLabel({ inputPerMtok: 0.075, outputPerMtok: 0.3 })).toBe('$0.075 / $0.3');
  });

  it('gives no price tail for an unpriced or a free model', () => {
    expect(formatModelPriceLabel(null)).toBeNull();
    expect(formatModelPriceLabel(undefined)).toBeNull();
    expect(formatModelPriceLabel({ inputPerMtok: 0, outputPerMtok: 0 })).toBeNull();
  });

  it('converts bigint and null token fields', () => {
    expect(toTokenNumber(5n)).toBe(5);
    expect(toTokenNumber(7)).toBe(7);
    expect(toTokenNumber(null)).toBe(0);
    expect(toTokenNumber(undefined)).toBe(0);
  });
});
