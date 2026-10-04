/**
 * Cost arithmetic and price labels for the status line, the model picker and
 * the palette.
 *
 * There is no price table here. Prices are resolved by the backend
 * (`crates/provider-core/src/pricing.rs`): the user's override, the provider's
 * own listing (OpenRouter), or the models.dev snapshot bundled with the
 * release. The renderer asks for them through `useModelPrices`. This module only
 * does the arithmetic, and it must match `pricing::estimate_cost_usd` exactly --
 * `costTable.test.ts` pins the same cases as the Rust tests.
 */

import type { ModelPrice, ProviderUsage } from '@conduit/config-schema';

/** Convert a possibly-null bigint/number token field to a safe number. */
export function toTokenNumber(value: bigint | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'bigint' ? Number(value) : value;
}

/**
 * Whether a provider's reported input count already includes cache reads.
 * Anthropic's Messages API reports input without them; OpenAI-style APIs (and
 * every preset built on them) and Gemini include them.
 */
export function inputIncludesCacheReads(providerId: string): boolean {
  return providerId !== 'anthropic';
}

/**
 * Estimated cost in USD cents of a usage record at `price`. Null when there is
 * no usage or no price: an unpriced model has an unknown cost, not a zero one.
 * Cache tokens without a published cache price are charged at the input price.
 */
export function estimateCostCents(
  usage: ProviderUsage | null | undefined,
  providerId: string,
  price: ModelPrice | null | undefined,
): number | null {
  if (!usage || !price) return null;
  const input = toTokenNumber(usage.inputTokens);
  const output = toTokenNumber(usage.outputTokens);
  const cacheRead = toTokenNumber(usage.cacheReadTokens);
  const cacheWrite = toTokenNumber(usage.cacheWriteTokens);
  const uncachedInput = inputIncludesCacheReads(providerId) ? Math.max(0, input - cacheRead) : input;
  const usd =
    (uncachedInput / 1e6) * price.inputPerMtok +
    (output / 1e6) * price.outputPerMtok +
    (cacheRead / 1e6) * (price.cacheReadPerMtok ?? price.inputPerMtok) +
    (cacheWrite / 1e6) * (price.cacheWritePerMtok ?? price.inputPerMtok);
  return usd * 100;
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

/** Per-Mtok dollars, trailing zeros trimmed: 3 → "3", 0.4 → "0.4", 0.075 → "0.075". */
function perMtokDollars(dollars: number): string {
  if (Number.isInteger(dollars)) return String(dollars);
  // Three decimals keep sub-dime prices (DeepSeek's $0.003 cache read) legible.
  return String(Number(dollars.toFixed(dollars < 0.1 ? 3 : 2)));
}

/**
 * The `$3 / $15` input/output tail shown beside a model (V9 §2.3), or null when
 * the model has no price -- the caller then falls back to a posture word
 * (`local`) from the provider descriptor rather than guessing a number. A free
 * model (both prices zero) also returns null, so local and `:free` models read
 * as a posture rather than "$0 / $0".
 *
 * Lives here rather than beside either of its two consumers: the composer's
 * model menu and the palette's `/models` corpus both show this tail, and the
 * same fact rendered two ways in two places is the drift `--code` and the ink
 * ramp were each fixed for.
 */
export function formatModelPriceLabel(price: ModelPrice | null | undefined): string | null {
  if (!price) return null;
  if (price.inputPerMtok === 0 && price.outputPerMtok === 0) return null;
  return `$${perMtokDollars(price.inputPerMtok)} / $${perMtokDollars(price.outputPerMtok)}`;
}
