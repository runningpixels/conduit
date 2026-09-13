/**
 * StatusLine — the provenance strip, reduced to one sentence (V9 §2.2).
 *
 * V8 reported model, key location, context use, spend and network posture as
 * five mono chips in a strip that was always on screen. That is the right
 * information at the wrong volume: a reference fact rendered as a permanent
 * HUD. V9 keeps every one of those facts and drops the volume to a single
 * muted line under the composer, with the fuller breakdown one click away in a
 * popover.
 *
 * t1-3: context fill is `contextTokens` (prompt-size estimate from ChatView),
 * not summed per-turn API usage. Spend still comes from `usage`. A compact
 * meter sits beside the %; warn styling when fill ≥ compact threshold.
 */

import { useRef, useState } from 'react';
import type { AppSettings, ProviderUsage } from '@conduit/config-schema';
import { providerDisplayName } from '../lib/providerIdentity';
import {
  DEFAULT_COMPACT_THRESHOLD_PERCENT,
  getContextWindow,
} from '../lib/contextWindows';
import { estimateCostCents, formatCostCents } from '../lib/costTable';
import { readExpandedStatus } from './uiPrefs';
import { ContextIcon, LockIcon, ModelIcon, ShieldIcon, SpendIcon } from '../icons';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { Menu } from '../workspace/Menu';

export type CredentialMode = 'none' | 'optional' | 'required' | 'loading';

interface StatusLineProps {
  settings: AppSettings;
  /** Open a settings section ('providers' | 'privacy' …). Optional — when
   *  absent, the popover's deep links render as non-interactive rows. */
  onOpenSettings?: (tab?: string) => void;
  /** Accumulated usage for spend (not context fill). */
  usage: ProviderUsage | null;
  /** Estimated tokens for the next request (history + system + tools + draft). */
  contextTokens: number;
  /** Auto-compact threshold percent; drives warn styling on the meter. */
  compactThresholdPercent?: number;
  /** Key posture of the active provider ('loading' while resolving). */
  credentialMode: CredentialMode;
  /** `keychain://…` reference, or empty when not configured. */
  credentialRef: string;
  /** Open the composer model picker. */
  modelMenuOpen: () => void;
}

export function StatusLine({
  settings,
  onOpenSettings,
  usage,
  contextTokens,
  compactThresholdPercent = DEFAULT_COMPACT_THRESHOLD_PERCENT,
  credentialMode,
  credentialRef,
  modelMenuOpen,
}: StatusLineProps) {
  const t = useT();
  const fmt = useFormatters();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // `Menu` closes on Escape or an outside press and hands focus back to the line.
  const close = () => setOpen(false);

  const tokens = Math.max(0, contextTokens);
  const contextWindow = getContextWindow(settings.activeModel);
  const percent = contextWindow != null ? Math.round((tokens / contextWindow) * 100) : null;
  const nearLimit = percent != null && percent >= compactThresholdPercent;
  const meterFill = percent != null ? Math.min(100, Math.max(0, percent)) : 0;

  // The sentence carries the ratio; the popover carries the raw counts. Same
  // fact, two volumes — which is the whole point of the collapse.
  const contextBrief =
    contextWindow != null
      ? t('shell.statusLine.context.ratio', { percent, window: fmt.compact(contextWindow) })
      : t('shell.statusLine.context.raw', { tokens: fmt.count(tokens) });
  const contextFull =
    contextWindow != null
      ? t('shell.statusLine.context.full', { tokens: fmt.count(tokens), window: fmt.compact(contextWindow) })
      : t('shell.statusLine.context.fullRaw', { tokens: fmt.count(tokens) });

  const estimatedCents = estimateCostCents(usage, settings.activeModel);
  const spendLabel =
    estimatedCents != null && estimatedCents > 0
      ? formatCostCents(estimatedCents)
      : (usage?.costHint ?? null);

  // 'loading' is not a posture, it is the absence of one — say nothing until it
  // resolves rather than flash "not configured" on every mount.
  const keyResolved = credentialMode !== 'loading';
  const keyMissing = keyResolved && credentialMode !== 'none' && !credentialRef;
  const notConfiguredLabel = t('shell.statusLine.notConfigured');
  const keyLabel = credentialMode === 'none' ? t('shell.statusLine.noKeyRequired') : credentialRef || notConfiguredLabel;

  const sep = <span className="sep" aria-hidden="true">·</span>;

  /**
   * V9 §10.1's escape hatch, read once per render from localStorage. When on,
   * the line re-inflates to the facts V8's five chips carried — the key
   * location and the raw context count join the sentence instead of waiting in
   * the popover. Same data, same element, same place: only the volume changes,
   * which is what §2.2 promised the toggle would do.
   */
  const expanded = readExpandedStatus() === 'on';

  return (
    <div className="status-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="status"
        data-expanded={expanded ? 'true' : undefined}
        data-context-warn={nearLimit ? 'true' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t('shell.statusLine.chatDetails')}
        onClick={() => setOpen((v) => !v)}
      >
        <i className="pdot" aria-hidden="true" />
        <span>{settings.activeModel}</span>
        {expanded && keyResolved && !keyMissing && (
          <>
            {sep}
            <span>{keyLabel}</span>
          </>
        )}
        {sep}
        {contextWindow != null && (
          <span
            className="ctx-meter"
            role="meter"
            aria-label={t('shell.statusLine.context.meterAriaLabel', { percent, window: fmt.compact(contextWindow) })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={meterFill}
          >
            <span className="ctx-meter-fill" style={{ width: `${meterFill}%` }} />
          </span>
        )}
        <span className={nearLimit ? 'warn' : undefined}>
          {expanded ? contextFull : contextBrief}
        </span>
        {spendLabel != null && (
          <>
            {sep}
            <span>{spendLabel}</span>
          </>
        )}
        {keyMissing && (
          <>
            {sep}
            <span className="warn">{notConfiguredLabel}</span>
          </>
        )}
        {sep}
        <span className={settings.localOnly ? 'local' : undefined}>
          {settings.localOnly ? t('shell.statusLine.localOnly') : t('shell.statusLine.online')}
        </span>
      </button>

      <Menu
        open={open}
        onClose={close}
        triggerRef={triggerRef}
        className="menu status-menu"
        label={t('shell.statusLine.chatDetails')}
        dismissOnOutsidePress
      >
        <div className="menu-label">{t('shell.statusLine.menu.thisChatHeading')}</div>

        <button
          type="button"
          className="menu-item"
          role="menuitem"
          onClick={() => {
            close();
            modelMenuOpen();
          }}
        >
          <ModelIcon />
          {providerDisplayName(settings.activeProvider)} / {settings.activeModel}
          <span className="tail">{t('shell.statusLine.menu.change')}</span>
        </button>

        {keyResolved &&
          (onOpenSettings ? (
            <button
              type="button"
              className={`menu-item${keyMissing ? ' warn' : ''}`}
              role="menuitem"
              onClick={() => {
                close();
                onOpenSettings('providers');
              }}
            >
              <LockIcon />
              {keyLabel}
              <span className="tail">{keyMissing ? t('shell.statusLine.menu.setUp') : t('shell.statusLine.menu.verified')}</span>
            </button>
          ) : (
            <span className={`menu-item${keyMissing ? ' warn' : ''}`}>
              <LockIcon />
              {keyLabel}
            </span>
          ))}

        <span className={`menu-item${nearLimit ? ' warn' : ''}`}>
          <ContextIcon />
          {t('shell.statusLine.menu.contextRow', { full: contextFull })}
          {percent != null && <span className="tail">{percent}%</span>}
        </span>

        {spendLabel != null && (
          <span className="menu-item">
            <SpendIcon />
            {t('shell.statusLine.menu.spendThisChat')}
            <span className="tail">{spendLabel}</span>
          </span>
        )}

        <div className="menu-sep" />

        {onOpenSettings ? (
          <button
            type="button"
            className={`menu-item${settings.localOnly ? ' local' : ''}`}
            role="menuitem"
            onClick={() => {
              close();
              onOpenSettings('privacy');
            }}
          >
            <ShieldIcon />
            {settings.localOnly ? t('shell.statusLine.menu.localOnlyDetail') : t('shell.statusLine.menu.online')}
          </button>
        ) : (
          <span className={`menu-item${settings.localOnly ? ' local' : ''}`}>
            <ShieldIcon />
            {settings.localOnly ? t('shell.statusLine.menu.localOnlyDetail') : t('shell.statusLine.menu.online')}
          </span>
        )}
      </Menu>
    </div>
  );
}
