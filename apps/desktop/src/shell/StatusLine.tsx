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

import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ProviderUsage } from '@conduit/config-schema';
import { providerDisplayName } from '../lib/providerIdentity';
import {
  DEFAULT_COMPACT_THRESHOLD_PERCENT,
  getContextWindow,
} from '../lib/contextWindows';
import { estimateCostCents, formatCostCents } from '../lib/costTable';
import { readExpandedStatus } from './uiPrefs';
import { ContextIcon, LockIcon, ModelIcon, ShieldIcon, SpendIcon } from '../icons';

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

/** Compact window formatting: 200000 → "200k", 1000000 → "1M". */
export function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return String(tokens);
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
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const close = () => setOpen(false);

  // Outside click + Escape close the popover; focus returns to the line.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      close();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const tokens = Math.max(0, contextTokens);
  const contextWindow = getContextWindow(settings.activeModel);
  const percent = contextWindow != null ? Math.round((tokens / contextWindow) * 100) : null;
  const nearLimit = percent != null && percent >= compactThresholdPercent;
  const meterFill = percent != null ? Math.min(100, Math.max(0, percent)) : 0;

  // The sentence carries the ratio; the popover carries the raw counts. Same
  // fact, two volumes — which is the whole point of the collapse.
  const contextBrief =
    contextWindow != null
      ? `${percent}% of ${formatWindow(contextWindow)}`
      : `${tokens.toLocaleString()} ctx`;
  const contextFull =
    contextWindow != null
      ? `${tokens.toLocaleString()} of ${formatWindow(contextWindow)}`
      : `${tokens.toLocaleString()} tokens`;

  const estimatedCents = estimateCostCents(usage, settings.activeModel);
  const spendLabel =
    estimatedCents != null && estimatedCents > 0
      ? formatCostCents(estimatedCents)
      : (usage?.costHint ?? null);

  // 'loading' is not a posture, it is the absence of one — say nothing until it
  // resolves rather than flash "not configured" on every mount.
  const keyResolved = credentialMode !== 'loading';
  const keyMissing = keyResolved && credentialMode !== 'none' && !credentialRef;
  const keyLabel = credentialMode === 'none' ? 'no key required' : credentialRef || 'not configured';

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
        title="Chat details"
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
            aria-label={`Context ${percent}% of ${formatWindow(contextWindow)}`}
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
            <span className="warn">not configured</span>
          </>
        )}
        {sep}
        <span className={settings.localOnly ? 'local' : undefined}>
          {settings.localOnly ? 'local only' : 'online'}
        </span>
      </button>

      {open && (
        <div ref={menuRef} className="menu status-menu" data-open="true" role="menu" aria-label="Chat details">
          <div className="menu-label">This chat</div>

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
            <span className="tail">change</span>
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
                <span className="tail">{keyMissing ? 'set up' : 'verified'}</span>
              </button>
            ) : (
              <span className={`menu-item${keyMissing ? ' warn' : ''}`}>
                <LockIcon />
                {keyLabel}
              </span>
            ))}

          <span className={`menu-item${nearLimit ? ' warn' : ''}`}>
            <ContextIcon />
            Context {contextFull}
            {percent != null && <span className="tail">{percent}%</span>}
          </span>

          {spendLabel != null && (
            <span className="menu-item">
              <SpendIcon />
              Spend this chat
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
              {settings.localOnly ? 'Local only — nothing leaves this machine' : 'Online'}
            </button>
          ) : (
            <span className={`menu-item${settings.localOnly ? ' local' : ''}`}>
              <ShieldIcon />
              {settings.localOnly ? 'Local only — nothing leaves this machine' : 'Online'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
