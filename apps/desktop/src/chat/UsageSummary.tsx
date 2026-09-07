import type { ProviderUsage } from '@conduit/config-schema';
import { InfoIcon } from '../icons';
import { useFormatters, type Formatters } from '../i18n/formatters';

interface UsageSummaryProps {
  usage?: ProviderUsage;
  /// Deprecated: search query count is shown on the search card header instead.
  searchCost?: number;
}

/** Build the muted `in` / `out` / `cache` lines for the per-turn tip. */
export function formatUsageParts(usage: ProviderUsage, fmt: Formatters): string[] {
  const parts: string[] = [];
  if (usage.inputTokens != null) parts.push(`in: ${fmt.count(Number(usage.inputTokens))}`);
  if (usage.outputTokens != null) parts.push(`out: ${fmt.count(Number(usage.outputTokens))}`);
  if (usage.cacheReadTokens != null && usage.cacheWriteTokens != null) {
    parts.push(`cache: ${fmt.count(Number(usage.cacheReadTokens))}⇠ ${fmt.count(Number(usage.cacheWriteTokens))}⇢`);
  } else if (usage.cacheTokens != null) {
    parts.push(`cache: ${fmt.count(Number(usage.cacheTokens))}`);
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
  const fmt = useFormatters();
  if (!usage) {
    return null;
  }
  const parts = formatUsageParts(usage, fmt);
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
