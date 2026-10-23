/// Tokens and cost of agent nodes (hand-offs in chat, rows of a run's agent
/// tree), by model. One place does the sums so a total always equals its lines.

import { useMemo } from 'react';
import type { ProviderUsage } from '@conduit/config-schema';
import { estimateCostCents } from '../lib/costTable';
import { useModelPrices } from '../lib/useModelPrices';
import { splitModel } from './ProviderBadge';

/// What one agent node used.
export interface NodeUsage {
  /// "provider/model"; empty when unknown.
  model: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelTotal {
  model: string;
  nodes: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /// Estimated cost in cents; null when the model has no price or no token split.
  cents: number | null;
}

export interface HelperTotals {
  byModel: ModelTotal[];
  tokens: number;
  /// Null when any model that used tokens could not be priced.
  cents: number | null;
}

function asUsage(u: NodeUsage): ProviderUsage {
  const big = (n: number) => BigInt(Math.max(0, Math.round(n)));
  return {
    inputTokens: big(u.inputTokens),
    outputTokens: big(u.outputTokens),
    cacheReadTokens: big(u.cacheReadTokens),
    cacheWriteTokens: big(u.cacheWriteTokens),
  };
}

/// Cost of one node or total at the given price lookup; null when unpriced or the split is unknown.
export function useNodeCosts(nodes: NodeUsage[]) {
  const requests = useMemo(() => {
    const byProvider = new Map<string, string[]>();
    for (const n of nodes) {
      const { providerId, modelId } = splitModel(n.model);
      if (!providerId || !modelId) continue;
      byProvider.set(providerId, [...(byProvider.get(providerId) ?? []), modelId]);
    }
    return [...byProvider].map(([providerId, modelIds]) => ({ providerId, modelIds }));
  }, [nodes]);
  const lookup = useModelPrices(requests);
  return useMemo(() => {
    const costOf = (u: NodeUsage): number | null => {
      const { providerId, modelId } = splitModel(u.model);
      if (!providerId || !modelId) return null;
      const split = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
      if (split <= 0) return null;
      return estimateCostCents(asUsage(u), providerId, lookup(providerId, modelId)?.price);
    };
    const totals = (): HelperTotals => {
      const groups = new Map<string, ModelTotal>();
      for (const n of nodes) {
        const g = groups.get(n.model) ?? {
          model: n.model,
          nodes: 0,
          tokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cents: null,
        };
        g.nodes += 1;
        g.tokens += n.tokens;
        g.inputTokens += n.inputTokens;
        g.outputTokens += n.outputTokens;
        g.cacheReadTokens += n.cacheReadTokens;
        g.cacheWriteTokens += n.cacheWriteTokens;
        groups.set(n.model, g);
      }
      const byModel = [...groups.values()];
      for (const g of byModel) g.cents = costOf(g);
      const used = byModel.filter((g) => g.tokens > 0);
      const priced = used.length > 0 && used.every((g) => g.cents !== null);
      return {
        byModel,
        tokens: byModel.reduce((sum, g) => sum + g.tokens, 0),
        cents: priced ? used.reduce((sum, g) => sum + (g.cents ?? 0), 0) : null,
      };
    };
    return { costOf, totals };
  }, [nodes, lookup]);
}
