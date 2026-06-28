import type { ProviderUsage } from '@conduit/config-schema';

interface UsageSummaryProps {
  usage?: ProviderUsage;
  /// Phase 7 / M-WebSearch: number of hosted web-search tool calls the
  /// model issued in this response. Surfaced as a row alongside the
  /// regular usage so users see the tool-call cost alongside tokens.
  searchCost?: number;
}

export function UsageSummary({ usage, searchCost }: UsageSummaryProps) {
  if (!usage && !searchCost) {
    return null;
  }
  const parts: string[] = [];
  if (usage) {
    if (usage.inputTokens !== undefined) parts.push(`in: ${usage.inputTokens}`);
    if (usage.outputTokens !== undefined) parts.push(`out: ${usage.outputTokens}`);
    if (usage.cacheTokens !== undefined) parts.push(`cache: ${usage.cacheTokens}`);
    if (usage.costHint) parts.push(usage.costHint);
  }
  if (searchCost && searchCost > 0) {
    parts.push(`web searches: ${searchCost}`);
  }

  if (parts.length === 0) return null;
  return <div className="usage-summary">{parts.map((p) => <span key={p}>{p}</span>)}</div>;
}