/// The reader's side of artifact network access (ADR-010): a banner when a
/// page asks for a site, the consent dialog that shows where it will connect
/// and what it sends, and the header chip listing every site with its
/// requests.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { GlobeIcon } from '../icons';
import { hostLabel, type DeclaredHost } from '../artifacts/networkHosts';
import type { ArtifactNetworkState } from '../ipc/client';
import type { NetworkDecision, NetworkLogEntry, PendingSite } from './useArtifactNetwork';

// ── Banner ───────────────────────────────────────────────────────────────────

export function ArtifactNetworkBanner({
  pending,
  onReview,
  onNotNow,
}: {
  pending: PendingSite[];
  onReview: () => void;
  onNotNow: () => void;
}) {
  const t = useT();
  if (pending.length === 0) return null;
  const hosts = pending.map((p) => hostLabel(p.origin));
  return (
    <div className="doc-banner hold artifact-network-banner" role="status">
      <span className="artifact-network-banner-text" title={hosts.join(', ')}>
        <GlobeIcon />
        {hosts.length === 1
          ? t('artifacts.network.banner.one', { host: hosts[0] })
          : t('artifacts.network.banner.many', { count: hosts.length, hosts: hosts.join(', ') })}
      </span>
      <div className="row">
        <button type="button" className="btn ghost" onClick={onNotNow}>
          {t('artifacts.network.banner.notNow')}
        </button>
        <button type="button" className="btn primary" onClick={onReview}>
          {t('artifacts.network.banner.review')}
        </button>
      </div>
    </div>
  );
}

// ── Consent dialog ───────────────────────────────────────────────────────────

const TEXT_TYPES = /^(text\/|application\/(json|x-www-form-urlencoded|xml|javascript)|[^;]*\+json)/i;

function bodyPreview(body: ArrayBuffer, contentType: string | undefined): string | null {
  const bytes = new Uint8Array(body.slice(0, 400));
  if (contentType && !TEXT_TYPES.test(contentType)) return null;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  // Mostly unreadable bytes read as binary even without a content type.
  const odd = [...text].filter((c) => c === '�' || (c < ' ' && c !== '\n' && c !== '\r' && c !== '\t')).length;
  if (odd > text.length / 10) return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    const path = `${u.pathname}${u.search}`;
    return path.length > 140 ? `${path.slice(0, 140)}…` : path;
  } catch {
    return url;
  }
}

export function ArtifactNetworkDialog({
  open,
  title,
  sites,
  declared,
  onDecide,
}: {
  open: boolean;
  title: string | null;
  sites: PendingSite[];
  declared: DeclaredHost[];
  onDecide: (decision: NetworkDecision) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const dialogRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    denyRef.current?.focus();
    // Capture phase: the panel's own Escape (close the document) must not see
    // this one.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDecide('deny');
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onDecide]);

  if (!open || sites.length === 0) return null;
  const sendsData = sites.some((s) => s.first.body && s.first.body.byteLength > 0);

  return (
    <div className="consent-overlay artifact-network-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="consent-dialog artifact-network-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="artifact-network-title"
      >
        <h2 id="artifact-network-title">
          {title
            ? t('artifacts.network.dialog.title', { title })
            : t('artifacts.network.dialog.titleUntitled')}
        </h2>
        <ul className="artifact-network-sites">
          {sites.map((site) => {
            const declaration = declared.find((d) => d.origin === site.origin);
            const body = site.first.body;
            const preview = body && body.byteLength > 0 ? bodyPreview(body, site.first.contentType) : null;
            return (
              <li key={site.origin}>
                <div className="artifact-network-host">
                  <GlobeIcon />
                  <b>{hostLabel(site.origin)}</b>
                </div>
                <div className={declaration ? 'artifact-network-declared' : 'artifact-network-undeclared'}>
                  {declaration
                    ? declaration.reason
                      ? t('artifacts.network.dialog.declared', { reason: declaration.reason })
                      : t('artifacts.network.dialog.declaredNoReason')
                    : t('artifacts.network.dialog.undeclared')}
                </div>
                <div className="artifact-network-request">
                  <span className="artifact-network-label">{t('artifacts.network.dialog.firstRequest')}</span>
                  <code>
                    {site.first.method} {pathOf(site.first.url)}
                  </code>
                  <span className="artifact-network-sends">
                    {!body || body.byteLength === 0
                      ? t('artifacts.network.dialog.sendsNothing')
                      : preview != null
                        ? t('artifacts.network.dialog.sendsText', { size: fmt.size(body.byteLength), preview })
                        : t('artifacts.network.dialog.sendsBinary', { size: fmt.size(body.byteLength) })}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <p className="artifact-network-note">
          {sendsData ? t('artifacts.network.dialog.noteSends') : t('artifacts.network.dialog.note')}
        </p>
        <div className="artifact-network-actions">
          <button ref={denyRef} type="button" className="btn ghost" onClick={() => onDecide('deny')}>
            {t('artifacts.network.dialog.deny')}
          </button>
          <button type="button" className="btn" onClick={() => onDecide('session')}>
            {t('artifacts.network.dialog.allowSession')}
          </button>
          <button type="button" className="btn primary" onClick={() => onDecide('page')}>
            {t('artifacts.network.dialog.allowPage')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Header chip: every site, its status, its requests ───────────────────────

type SiteStatus = 'always' | 'session' | 'denied' | 'unasked';

interface SiteRow {
  origin: string;
  source: 'declared' | 'scripted' | 'contacted';
  reason?: string;
  status: SiteStatus;
  requests: number;
}

export function ArtifactNetworkChip({
  declared,
  scripted,
  state,
  denied,
  log,
  onRevoke,
}: {
  declared: DeclaredHost[];
  scripted: string[];
  state: ArtifactNetworkState | null;
  denied: ReadonlySet<string>;
  log: NetworkLogEntry[];
  onRevoke: (origin: string) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    // Capture phase, handled: Escape closes the list, not the document.
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const rows = useMemo<SiteRow[]>(() => {
    const status = (origin: string): SiteStatus =>
      state?.always.includes(origin)
        ? 'always'
        : state?.session.includes(origin)
          ? 'session'
          : denied.has(origin)
            ? 'denied'
            : 'unasked';
    const count = (origin: string) => log.filter((e) => e.origin === origin).length;
    const out = new Map<string, SiteRow>();
    for (const d of declared) {
      out.set(d.origin, { origin: d.origin, source: 'declared', reason: d.reason, status: status(d.origin), requests: count(d.origin) });
    }
    for (const origin of scripted) {
      if (!out.has(origin)) out.set(origin, { origin, source: 'scripted', status: status(origin), requests: count(origin) });
    }
    for (const origin of [...(state?.always ?? []), ...(state?.session ?? []), ...denied, ...log.map((e) => e.origin)]) {
      if (!out.has(origin)) out.set(origin, { origin, source: 'contacted', status: status(origin), requests: count(origin) });
    }
    return [...out.values()];
  }, [declared, scripted, state, denied, log]);

  if (rows.length === 0) return null;
  const recent = log.slice(-20).reverse();

  return (
    <div className="artifact-network-chip-root" ref={rootRef}>
      <button
        type="button"
        className="artifact-network-chip"
        aria-expanded={open}
        aria-label={t('artifacts.network.chip.ariaLabel')}
        title={t('artifacts.network.chip.ariaLabel')}
        onClick={() => setOpen((v) => !v)}
      >
        <GlobeIcon />
        <span>{t('artifacts.network.chip.label', { count: rows.length })}</span>
      </button>
      {open && (
        <div className="artifact-network-popover" role="dialog" aria-label={t('artifacts.network.chip.ariaLabel')}>
          <h3>{t('artifacts.network.popover.title')}</h3>
          {state?.blockedReason && <p className="artifact-network-blocked">{state.blockedReason}</p>}
          {rows.length === 0 ? (
            <p className="artifact-network-muted">{t('artifacts.network.popover.empty')}</p>
          ) : (
            <ul className="artifact-network-rows">
              {rows.map((row) => (
                <li key={row.origin}>
                  <div className="artifact-network-row-head">
                    <b>{hostLabel(row.origin)}</b>
                    <span className="artifact-network-status" data-status={row.status}>
                      {t(`artifacts.network.status.${row.status}`)}
                    </span>
                  </div>
                  <div className="artifact-network-muted">
                    {row.source === 'declared'
                      ? row.reason
                        ? t('artifacts.network.source.declared', { reason: row.reason })
                        : t('artifacts.network.source.declaredNoReason')
                      : t(`artifacts.network.source.${row.source}`)}
                    {row.requests > 0 && ` · ${t('artifacts.network.popover.requests', { count: row.requests })}`}
                  </div>
                  {(row.status === 'always' || row.status === 'session') && (
                    <button type="button" className="btn ghost artifact-network-remove" onClick={() => onRevoke(row.origin)}>
                      {t('artifacts.network.popover.remove')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {recent.length > 0 && (
            <>
              <h4>{t('artifacts.network.popover.log')}</h4>
              <ol className="artifact-network-log">
                {recent.map((entry) => (
                  <li key={entry.id} className={entry.error ? 'is-error' : undefined}>
                    <code>
                      {entry.method} {hostLabel(entry.origin)}
                      {pathOf(entry.url)}
                    </code>
                    <span>
                      {entry.error
                        ? entry.error
                        : entry.status != null
                          ? `${entry.status} · ${fmt.size(entry.bytes ?? 0)} · ${entry.ms ?? 0} ms`
                          : t('artifacts.network.popover.waiting')}
                      {entry.sinceChange && ` · ${t('artifacts.network.popover.sinceChange')}`}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  );
}
