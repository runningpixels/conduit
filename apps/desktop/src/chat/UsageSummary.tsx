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
  if (usage.inputTokens != null) parts.push(`in: ${usage.inputTokens.toLocaleString()}`);
  if (usage.outputTokens != null) parts.push(`out: ${usage.outputTokens.toLocaleString()}`);
  if (usage.cacheReadTokens != null && usage.cacheWriteTokens != null) {
    parts.push(`cache: ${usage.cacheReadTokens.toLocaleString()}⇠ ${usage.cacheWriteTokens.toLocaleString()}⇢`);
  } else if (usage.cacheTokens != null) {
    parts.push(`cache: ${usage.cacheTokens.toLocaleString()}`);
  }
  if (usage.costHint) parts.push(usage.costHint);

  if (parts.length === 0) return null;
  return <div className="usage-summary">{parts.map((p) => <span key={p}>{p}</span>)}</div>;
}
