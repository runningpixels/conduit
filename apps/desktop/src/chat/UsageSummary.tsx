import type { ProviderUsage } from '@conduit/config-schema';

interface UsageSummaryProps {
  usage?: ProviderUsage;
  /// Deprecated: search query count is shown on the search card header instead.
  searchCost?: number;
}

export function UsageSummary({ usage }: UsageSummaryProps) {
  if (!usage) {
    return null;
  }
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`in: ${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out: ${usage.outputTokens}`);
  if (usage.cacheTokens !== undefined) parts.push(`cache: ${usage.cacheTokens}`);
  if (usage.costHint) parts.push(usage.costHint);

  if (parts.length === 0) return null;
  return <div className="usage-summary">{parts.map((p) => <span key={p}>{p}</span>)}</div>;
}
