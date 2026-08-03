/**
 * ProvenanceStrip — the canonical, single home for every provenance fact
 * (conduit-v7-design-spec §6.3).
 *
 * One mono line beneath the composer: provider/model, key location, context
 * use, spend, network posture. Segments are separated by a 1px `--line-soft`
 * left border; the leading dot is the active provider's hue. Nothing else in
 * the renderer reports these facts — per-turn usage is hover-only audit
 * detail (UsageSummary), not a second report.
 */

import type { AppSettings, ProviderUsage } from '@conduit/config-schema';
import { providerDisplayName } from '../lib/providerIdentity';
import { getContextWindow, sumUsageTokens } from '../lib/contextWindows';
import { estimateCostCents, formatCostCents } from '../lib/costTable';
import { LockIcon } from '../icons';

export type CredentialMode = 'none' | 'optional' | 'required' | 'loading';

interface ProvenanceStripProps {
  settings: AppSettings;
  /** Open a settings section ('providers' | 'privacy' …). Optional — when
   *  absent, interactive segments render as non-interactive spans. */
  onOpenSettings?: (tab?: string) => void;
  /** Accumulated usage for the whole conversation (turns + live stream). */
  usage: ProviderUsage | null;
  /** Pending composer token estimate, added to the context-use segment. */
  composerTokenEstimate: number;
  /** Key posture of the active provider ('loading' while resolving). */
  credentialMode: CredentialMode;
  /** `keychain://…` reference, or empty when not configured. */
  credentialRef: string;
  /** Open the composer model picker. */
  modelMenuOpen: () => void;
}

/** Compact window formatting: 200000 → "200k", 1000000 → "1M". */
function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
}

export function ProvenanceStrip({
  settings,
  onOpenSettings,
  usage,
  composerTokenEstimate,
  credentialMode,
  credentialRef,
  modelMenuOpen,
}: ProvenanceStripProps) {
  const tokens = sumUsageTokens(usage) + composerTokenEstimate;
  const contextWindow = getContextWindow(settings.activeModel);
  const contextLabel =
    contextWindow != null
      ? `${tokens.toLocaleString()} ctx · ${Math.round((tokens / contextWindow) * 100)}% of ${formatWindow(contextWindow)}`
      : `${tokens.toLocaleString()} ctx`;

  const estimatedCents = estimateCostCents(usage, settings.activeModel);
  const spendLabel =
    estimatedCents != null && estimatedCents > 0
      ? `${formatCostCents(estimatedCents)} this chat`
      : usage?.costHint
        ? `${usage.costHint} this chat`
        : null;

  let keyLabel: string;
  let keyWarn = false;
  if (credentialMode === 'none') {
    keyLabel = 'no key required';
  } else if (credentialRef) {
    keyLabel = credentialRef;
  } else {
    keyLabel = 'not configured';
    keyWarn = true;
  }

  return (
    <div className="provenance">
      <button type="button" className="prov" onClick={modelMenuOpen} title="Open model switcher">
        <i className="pdot" aria-hidden="true" />
        <b>
          {providerDisplayName(settings.activeProvider)} / {settings.activeModel}
        </b>
      </button>

      {credentialMode !== 'loading' &&
        (onOpenSettings ? (
          <button
            type="button"
            className={`prov${keyWarn ? ' warn' : ''}`}
            onClick={() => onOpenSettings('providers')}
            title="Manage providers and keys"
          >
            <LockIcon />
            {keyLabel}
          </button>
        ) : (
          <span className={`prov${keyWarn ? ' warn' : ''}`}>
            <LockIcon />
            {keyLabel}
          </span>
        ))}

      <span className="prov">{contextLabel}</span>

      {spendLabel != null &&
        (onOpenSettings ? (
          <button
            type="button"
            className="prov"
            onClick={() => onOpenSettings('advanced')}
            title="Usage and cost"
          >
            {spendLabel}
          </button>
        ) : (
          <span className="prov">{spendLabel}</span>
        ))}

      {onOpenSettings ? (
        <button
          type="button"
          className={`prov${settings.localOnly ? ' local' : ''}`}
          onClick={() => onOpenSettings('privacy')}
          title="Privacy and data"
        >
          {settings.localOnly ? '● local only' : 'online'}
        </button>
      ) : (
        <span className={`prov${settings.localOnly ? ' local' : ''}`}>
          {settings.localOnly ? '● local only' : 'online'}
        </span>
      )}
    </div>
  );
}
