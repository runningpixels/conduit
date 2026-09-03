/**
 * Context-window + token-accounting helpers for the status line's
 * context-use and spend segments (conduit-v7-design-spec §6.3, §15 Q2).
 *
 * Decision (implementation-plan Q2, t1-3): bundle a static map of known model
 * context windows plus prefix matching for families. When a model is unknown
 * the segment degrades to a raw token count (no percent) rather than guessing.
 *
 * Context *fill* is estimated from the prompt that would be sent next
 * (chars÷4), not from summing every turn's API usage (which double-counts
 * re-sent history).
 */

import type { ProviderUsage, ToolDefinition } from '@conduit/config-schema';
import { estimateCostCents, toTokenNumber } from './costTable';

/** Default auto-compact threshold (percent of window). */
export const DEFAULT_COMPACT_THRESHOLD_PERCENT = 90;

/** Exact model id → context window (tokens). */
const CONTEXT_WINDOWS: Record<string, number> = {
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-3-5-sonnet-latest': 200_000,
  'claude-3-7-sonnet-latest': 200_000,
  'gpt-4.1': 1_000_000,
  'gpt-4.1-mini': 1_000_000,
  'gpt-4.1-nano': 1_000_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'o3': 200_000,
  'o3-mini': 200_000,
  'o4-mini': 200_000,
  'gemini-2.0-flash': 1_000_000,
  'gemini-2.5-flash': 1_000_000,
  'gemini-2.5-pro': 1_000_000,
  'glm-4.5': 128_000,
  'glm-4.5-flash': 128_000,
  'glm-4.6': 200_000,
  'glm-5': 200_000,
  'glm-5.3-flash': 200_000,
};

/**
 * Longest-prefix-first family rules for OpenRouter-style ids
 * (`z-ai/glm-5.3-flash`, `anthropic/claude-sonnet-4`, …).
 */
const CONTEXT_WINDOW_PREFIXES: Array<{ prefix: string; window: number }> = [
  { prefix: 'claude-opus', window: 200_000 },
  { prefix: 'claude-sonnet', window: 200_000 },
  { prefix: 'claude-3', window: 200_000 },
  { prefix: 'claude', window: 200_000 },
  { prefix: 'gpt-4.1', window: 1_000_000 },
  { prefix: 'gpt-4o', window: 128_000 },
  { prefix: 'gpt-5', window: 400_000 },
  { prefix: 'o3', window: 200_000 },
  { prefix: 'o4', window: 200_000 },
  { prefix: 'gemini-2', window: 1_000_000 },
  { prefix: 'gemini-1.5', window: 1_000_000 },
  { prefix: 'gemini', window: 1_000_000 },
  { prefix: 'glm-5', window: 200_000 },
  { prefix: 'glm-4.6', window: 200_000 },
  { prefix: 'glm-4.5', window: 128_000 },
  { prefix: 'glm-4', window: 128_000 },
  { prefix: 'glm', window: 128_000 },
  { prefix: 'deepseek', window: 128_000 },
  { prefix: 'qwen', window: 128_000 },
  { prefix: 'llama-3', window: 128_000 },
  { prefix: 'llama', window: 128_000 },
  { prefix: 'mistral', window: 128_000 },
];

/** Strip `provider/` prefix from OpenRouter-style model ids. */
function bareModelId(modelId: string): string {
  const slash = modelId.lastIndexOf('/');
  return slash >= 0 ? modelId.slice(slash + 1) : modelId;
}

/** Context window (in tokens) for a model id; null when unknown. */
export function getContextWindow(modelId: string): number | null {
  if (!modelId) return null;
  const exact = CONTEXT_WINDOWS[modelId] ?? CONTEXT_WINDOWS[bareModelId(modelId)];
  if (exact != null) return exact;

  const bare = bareModelId(modelId).toLowerCase();
  const full = modelId.toLowerCase();
  for (const { prefix, window } of CONTEXT_WINDOW_PREFIXES) {
    if (bare.startsWith(prefix) || full.includes(`/${prefix}`)) {
      return window;
    }
  }
  return null;
}

/** Rough token count: ~4 characters per token (same heuristic as the composer). */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(0, Math.round(text.length / 4));
}

export interface PromptEstimateInput {
  /** Prior chat turns that would be resent (user/assistant text). */
  historyTexts: string[];
  /** System / developer / instruction blobs included in the request. */
  systemTexts?: string[];
  /** Tool definitions serialized into the request. */
  toolDefinitions?: ToolDefinition[] | null;
  /** Pending composer draft. */
  composerText?: string;
  /** Optional compaction summary already injected into the prompt. */
  compactionSummary?: string | null;
}

/**
 * Estimate tokens for the *next* provider request (prompt fill), not lifetime
 * spend. Prefer this over summing per-turn `ProviderUsage`.
 */
export function estimatePromptTokens(input: PromptEstimateInput): number {
  let chars = 0;
  for (const t of input.historyTexts) chars += t.length;
  for (const t of input.systemTexts ?? []) chars += t.length;
  if (input.composerText) chars += input.composerText.length;
  if (input.compactionSummary) chars += input.compactionSummary.length;
  if (input.toolDefinitions && input.toolDefinitions.length > 0) {
    try {
      chars += JSON.stringify(input.toolDefinitions).length;
    } catch {
      /* ignore circular / non-serializable defs */
    }
  }
  return Math.max(0, Math.round(chars / 4));
}

/** Fill percent of the model window; null when the window is unknown. */
export function contextFillPercent(
  tokens: number,
  modelId: string,
): number | null {
  const window = getContextWindow(modelId);
  if (window == null || window <= 0) return null;
  return Math.min(999, Math.round((tokens / window) * 100));
}

/**
 * Total tokens consumed by a usage record: input + output + cache-read +
 * cache-write. The legacy `cacheTokens` field doubles as cache-read when the
 * split fields are absent. IPC may deliver `null` for Rust `Option<u64>`, so
 * every field is handled defensively.
 *
 * Prefer {@link estimatePromptTokens} for context *fill*; this remains for
 * spend / analytics.
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
 * the later record (`b`). Used by ChatView for spend accumulation across a
 * conversation plus the live streaming turn.
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
