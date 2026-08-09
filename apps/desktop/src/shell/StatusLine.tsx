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
 * It reads exactly the inputs the strip did — same props, same helpers
 * (`getContextWindow`, `sumUsageTokens`, `estimateCostCents`,
 * `formatCostCents`, `providerDisplayName`). Only the presentation collapses;
 * nothing about the data model moves.
 *
 * Two deliberate departures from the mockup:
 *
 *   1. A missing key is promoted into the sentence in `--warn`, not buried in
 *      the popover. Every other fact here is a reference fact you consult; an
 *      unconfigured key is the one that is *actionable*, and hiding it one
 *      click down turns a fixable state into a send that fails for no visible
 *      reason.
 *   2. The popover keeps a route to the model switcher. V9 moves the model
 *      chip to the composer, which is right — that is where a switch happens —
 *      but the strip's chip was also the only way to reach the picker from
 *      here, and dropping the route outright would lose a capability rather
 *      than relocate one.
 */

import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ProviderUsage } from '@conduit/config-schema';
import { providerDisplayName } from '../lib/providerIdentity';
import { getContextWindow, sumUsageTokens } from '../lib/contextWindows';
import { estimateCostCents, formatCostCents } from '../lib/costTable';
import { ContextIcon, LockIcon, ModelIcon, ShieldIcon, SpendIcon } from '../icons';

export type CredentialMode = 'none' | 'optional' | 'required' | 'loading';

interface StatusLineProps {
  settings: AppSettings;
  /** Open a settings section ('providers' | 'privacy' …). Optional — when
   *  absent, the popover's deep links render as non-interactive rows. */
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
  composerTokenEstimate,
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

  const tokens = sumUsageTokens(usage) + composerTokenEstimate;
  const contextWindow = getContextWindow(settings.activeModel);
  const percent = contextWindow != null ? Math.round((tokens / contextWindow) * 100) : null;

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

  return (
    <div className="status-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="status"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Chat details"
        onClick={() => setOpen((v) => !v)}
      >
        <i className="pdot" aria-hidden="true" />
        <span>{settings.activeModel}</span>
        {sep}
        <span>{contextBrief}</span>
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

          <span className="menu-item">
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
