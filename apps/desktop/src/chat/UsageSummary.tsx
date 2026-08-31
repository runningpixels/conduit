import type { ProviderUsage } from '@conduit/config-schema';
import { InfoIcon } from '../icons';

interface UsageSummaryProps {
  usage?: ProviderUsage;
  /// Deprecated: search query count is shown on the search card header instead.
  searchCost?: number;
}

/** Build the muted `in` / `out` / `cache` lines for the per-turn tip. */
export function formatUsageParts(usage: ProviderUsage): string[] {
  const parts: string[] = [];
  if (usage.inputTokens != null) parts.push(`in: ${usage.inputTokens.toLocaleString()}`);
  if (usage.outputTokens != null) parts.push(`out: ${usage.outputTokens.toLocaleString()}`);
  if (usage.cacheReadTokens != null && usage.cacheWriteTokens != null) {
    parts.push(`cache: ${usage.cacheReadTokens.toLocaleString()}⇠ ${usage.cacheWriteTokens.toLocaleString()}⇢`);
  } else if (usage.cacheTokens != null) {
    parts.push(`cache: ${usage.cacheTokens.toLocaleString()}`);
  }
  if (usage.costHint) parts.push(usage.costHint);
  return parts;
}

/**
 * Icon-only affordance in the reserved turn footer. Token counts stay behind
 * a hover/focus tip so the action row stays compact and never grows on reveal.
 * Status line beneath the composer remains the canonical report (§6.3).
 */
export function UsageSummary({ usage }: UsageSummaryProps) {
  if (!usage) {
    return null;
  }
  const parts = formatUsageParts(usage);
  if (parts.length === 0) return null;

  const label = parts.join(' · ');
  return (
    <button
      type="button"
      className="act usage-summary"
      aria-label={`Token usage: ${label}`}
    >
      <InfoIcon />
      <span className="usage-summary-tip" role="tooltip" aria-hidden="true">
        {parts.map((p) => (
          <span key={p}>{p}</span>
        ))}
      </span>
    </button>
  );
}
