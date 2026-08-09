/**
 * Bundled per-model pricing for the status line's spend segment
 * (conduit-v7-design-spec §6.3, §15 Q1).
 *
 * Decision (implementation-plan Q1): bundle a small static table of per-Mtok
 * prices for known models. When the model is unknown the renderer falls back
 * to the backend's own `costHint` string, and when neither exists the spend
 * segment is omitted rather than guessed.
 */

import type { ProviderUsage } from '@conduit/config-schema';

export interface ModelPrices {
  /** USD cents per 1M input tokens */
  inputPerMtokCents: number;
  /** USD cents per 1M output tokens */
  outputPerMtokCents: number;
  /** USD cents per 1M cache-read tokens */
  cacheReadPerMtokCents: number;
}

/** Per-Mtok pricing for known models (public list prices, USD). */
const PRICE_TABLE: Record<string, ModelPrices> = {
  'claude-sonnet-4': { inputPerMtokCents: 300, outputPerMtokCents: 1500, cacheReadPerMtokCents: 30 },
  'claude-opus-4': { inputPerMtokCents: 1500, outputPerMtokCents: 7500, cacheReadPerMtokCents: 150 },
  'gpt-4.1': { inputPerMtokCents: 200, outputPerMtokCents: 800, cacheReadPerMtokCents: 50 },
  'gpt-4.1-mini': { inputPerMtokCents: 40, outputPerMtokCents: 160, cacheReadPerMtokCents: 10 },
  'gpt-4o': { inputPerMtokCents: 250, outputPerMtokCents: 1000, cacheReadPerMtokCents: 125 },
  'gpt-4o-mini': { inputPerMtokCents: 15, outputPerMtokCents: 60, cacheReadPerMtokCents: 7.5 },
  'o3-mini': { inputPerMtokCents: 110, outputPerMtokCents: 440, cacheReadPerMtokCents: 55 },
};

/** Convert a possibly-null bigint/number token field to a safe number. */
export function toTokenNumber(value: bigint | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

/** Look up per-Mtok prices for a model id; null when unknown. */
export function getModelPrices(modelId: string): ModelPrices | null {
  if (!modelId) return null;
  return PRICE_TABLE[modelId] ?? null;
}

/**
 * Estimate the cost (in USD cents) of a usage record under a model.
 * Cache-read tokens are priced at the cache-read rate; cache-write tokens at
 * the output rate. Returns null when the model is unknown (the caller then
 * falls back to `usage.costHint`, or omits the segment).
 */
export function estimateCostCents(
  usage: ProviderUsage | null | undefined,
  modelId: string,
): number | null {
  if (!usage) return null;
  const prices = getModelPrices(modelId);
  if (!prices) return null;
  const input = toTokenNumber(usage.inputTokens);
  const output = toTokenNumber(usage.outputTokens);
  const cacheRead = toTokenNumber(usage.cacheReadTokens);
  const cacheWrite = toTokenNumber(usage.cacheWriteTokens);
  return (
    (input / 1e6) * prices.inputPerMtokCents +
    (output / 1e6) * prices.outputPerMtokCents +
    (cacheRead / 1e6) * prices.cacheReadPerMtokCents +
    (cacheWrite / 1e6) * prices.outputPerMtokCents
  );
}

/**
 * Format a cost in cents as a USD string, e.g. 1.44 → "$0.0144",
 * 5 → "$0.05", 100 → "$1.00". Keeps up to four decimals for sub-cent costs
 * and trims trailing zeros below one dollar.
 */
export function formatCostCents(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  const raw = dollars < 0.1 ? dollars.toFixed(4) : dollars.toFixed(2);
  return `$${raw.replace(/\.?0+$/, '')}`;
}
