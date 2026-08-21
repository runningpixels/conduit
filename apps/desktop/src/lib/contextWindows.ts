/**
 * Context-window + token-accounting helpers for the status line's
 * context-use and spend segments (conduit-v7-design-spec §6.3, §15 Q2).
 *
 * Decision (implementation-plan Q2): bundle a small static map of known model
 * context windows. When a model is unknown the segment degrades to a raw token
 * count (no percent) rather than guessing a window.
 */

import type { ProviderUsage } from '@conduit/config-schema';
import { estimateCostCents, toTokenNumber } from './costTable';

/** Known model context windows (tokens). */
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-sonnet-4': 200000,
  'claude-opus-4': 200000,
  'gpt-4.1': 1000000,
  'gpt-4.1-mini': 1000000,
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'o3-mini': 200000,
};

/** Context window (in tokens) for a model id; null when unknown. */
export function getContextWindow(modelId: string): number | null {
  if (!modelId) return null;
  return CONTEXT_WINDOWS[modelId] ?? null;
}

/**
 * Total tokens consumed by a usage record: input + output + cache-read +
 * cache-write. The legacy `cacheTokens` field doubles as cache-read when the
 * split fields are absent. IPC may deliver `null` for Rust `Option<u64>`, so
 * every field is handled defensively.
 */
export function sumUsageTokens(usage: ProviderUsage | null | undefined): number {
  if (!usage) return 0;
  const input = toTokenNumber(usage.inputTokens);
  const output = toTokenNumber(usage.outputTokens);
  const cacheRead = toTokenNumber(usage.cacheReadTokens ?? usage.cacheTokens);
  const cacheWrite = toTokenNumber(usage.cacheWriteTokens);
  return input + output + cacheRead + cacheWrite;
}

/**
 * Estimated cost (USD cents) of a usage record under a model. Null when the
 * model is unknown (see costTable.estimateCostCents); the caller falls back
 * to the backend's `costHint` string or omits the spend segment.
 */
export function sumUsageCostCents(
  usage: ProviderUsage | null | undefined,
  modelId: string,
): number | null {
  return estimateCostCents(usage, modelId);
}

function addTokens(
  x: bigint | number | null | undefined,
  y: bigint | number | null | undefined,
): bigint | undefined {
  const total = toTokenNumber(x) + toTokenNumber(y);
  return total === 0 ? undefined : BigInt(total);
}

/**
 * Merge two usage records: token fields are summed, `costHint` is kept from
 * the later record (`b`). Used by ChatView to accumulate per-turn usage across
 * a conversation plus the live streaming turn.
 */
export function mergeProviderUsage(
  a: ProviderUsage | null | undefined,
  b: ProviderUsage | null | undefined,
): ProviderUsage | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return {
    inputTokens: addTokens(a.inputTokens, b.inputTokens),
    outputTokens: addTokens(a.outputTokens, b.outputTokens),
    cacheTokens: addTokens(a.cacheTokens, b.cacheTokens),
    cacheReadTokens: addTokens(a.cacheReadTokens, b.cacheReadTokens),
    cacheWriteTokens: addTokens(a.cacheWriteTokens, b.cacheWriteTokens),
    costHint: b.costHint ?? a.costHint,
  };
}
