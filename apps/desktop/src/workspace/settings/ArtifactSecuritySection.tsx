import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@conduit/ui';
import type { AppSettings } from '../../ipc/contracts';
import {
  clearArtifactNetworkGrants,
  listArtifactNetworkGrants,
  revokeArtifactNetworkGrant,
  type ArtifactNetworkGrant,
} from '../../ipc/client';
import { hostLabel } from '../../artifacts/networkHosts';
import { ANY_SITE, FULL_WEB_ACCESS } from '../useArtifactNetwork';
import { clearAllPageSiteData, sweepPageSiteData } from '../../artifacts/pageSiteData';
import { useT } from '../../i18n';

interface ArtifactSecuritySectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
}

/**
 * Artifact Security: whether pages may connect to the internet (ADR-010) with
 * the sites each page was always allowed (and the pages given full web
 * access, ADR-007), whether every page gets full web access, clearing what
 * pages keep on their own origins (cookies, storage), and the passive remote
 * allowlist.
 */
export function ArtifactSecuritySection({ settings, onUpdate }: ArtifactSecuritySectionProps) {
  const t = useT();
  const [allowlistInput, setAllowlistInput] = useState('');
  const [grants, setGrants] = useState<ArtifactNetworkGrant[] | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);

  const loadGrants = useCallback(async () => {
    try {
      setGrants(await listArtifactNetworkGrants());
      setGrantError(null);
    } catch (e) {
      setGrantError(String(e));
    }
  }, []);
  useEffect(() => {
    void loadGrants();
  }, [loadGrants]);

  // A page that loses full web access loses its own origin; what it kept
  // there is cleared. Turning the every-page switch off can do that to many.
  const fullForEveryPage = settings.artifactFullWebAccess === true;
  const wasFullForEveryPage = useRef(fullForEveryPage);
  useEffect(() => {
    if (wasFullForEveryPage.current && !fullForEveryPage) void sweepPageSiteData({ everyPage: false });
    wasFullForEveryPage.current = fullForEveryPage;
  }, [fullForEveryPage]);

  async function handleRevokeGrant(grant: ArtifactNetworkGrant) {
    try {
      await revokeArtifactNetworkGrant(grant.principal, grant.host);
    } catch (e) {
      setGrantError(String(e));
    }
    await loadGrants();
    if (grant.host === FULL_WEB_ACCESS) void sweepPageSiteData();
  }

  async function handleClearGrants() {
    try {
      await clearArtifactNetworkGrants();
    } catch (e) {
      setGrantError(String(e));
    }
    await loadGrants();
    void sweepPageSiteData();
  }

  // "Clear data for all pages": every page origin, and the cookies of what
  // pages embed.
  const [siteDataConfirmOpen, setSiteDataConfirmOpen] = useState(false);
  const [siteDataBusy, setSiteDataBusy] = useState(false);
  const [siteDataStatus, setSiteDataStatus] = useState<{ ok: boolean } | null>(null);
  async function handleClearSiteData() {
    setSiteDataConfirmOpen(false);
    setSiteDataBusy(true);
    setSiteDataStatus(null);
    try {
      const result = await clearAllPageSiteData();
      setSiteDataStatus({ ok: result.failed === 0 });
    } catch {
      setSiteDataStatus({ ok: false });
    } finally {
      setSiteDataBusy(false);
    }
  }

  function handleAdd() {
    const v = allowlistInput.trim();
    if (!v) return;
    if (settings.artifactRemoteAllowlist.includes(v)) {
      setAllowlistInput('');
      return;
    }
    onUpdate({ ...settings, artifactRemoteAllowlist: [...settings.artifactRemoteAllowlist, v] });
    setAllowlistInput('');
  }

  function handleRemove(origin: string) {
    onUpdate({
      ...settings,
      artifactRemoteAllowlist: settings.artifactRemoteAllowlist.filter((o) => o !== origin),
    });
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>{t('settings.artifactSecurity.header.title')}</span>
      </div>
      <div className="srow">
        <span className="srow-text">
          <b>{t('settings.artifactSecurity.network.label')}</b>
          <small>
            {settings.localOnly
              ? t('settings.artifactSecurity.network.hintLocalOnly')
              : t('settings.artifactSecurity.network.hint')}
          </small>
        </span>
        <button
          className="toggle"
          type="button"
          role="switch"
          aria-pressed={settings.artifactNetworkEnabled}
          aria-label={t('settings.artifactSecurity.network.label')}
          onClick={() => onUpdate({ ...settings, artifactNetworkEnabled: !settings.artifactNetworkEnabled })}
        />
      </div>
      <div className="srow">
        <span className="srow-text">
          <b>{t('settings.artifactSecurity.fullAccess.label')}</b>
          <small>{t('settings.artifactSecurity.fullAccess.hint')}</small>
        </span>
        <button
          className="toggle"
          type="button"
          role="switch"
          aria-pressed={settings.artifactFullWebAccess === true}
          aria-label={t('settings.artifactSecurity.fullAccess.label')}
          onClick={() => onUpdate({ ...settings, artifactFullWebAccess: settings.artifactFullWebAccess !== true })}
        />
      </div>
      <div className="status-item">
        <span style={{ color: 'var(--ink-3)', fontSize: 'var(--fs-xl)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          {t('settings.artifactSecurity.grants.label')}
        </span>
        <span style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {t('settings.artifactSecurity.grants.hint')}
        </span>
        {grantError && (
          <span role="alert" style={{ fontSize: 'var(--fs-xl)', color: 'var(--err)' }}>
            {grantError}
          </span>
        )}
        {grants == null ? null : grants.length === 0 ? (
          <span style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-3)' }}>{t('settings.artifactSecurity.grants.empty')}</span>
        ) : (
          <>
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 4 }}>
              {grants.map((grant) => (
                <li
                  key={`${grant.principal}|${grant.host}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-xl)' }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{grant.host === ANY_SITE
                        ? t('artifacts.network.anySite')
                        : grant.host === FULL_WEB_ACCESS
                          ? t('artifacts.fullAccess.label')
                          : hostLabel(grant.host)}</span>
                    <span style={{ color: 'var(--ink-3)' }}>
                      {' · '}
                      {grant.title ?? t('settings.artifactSecurity.grants.untitled')}
                    </span>
                  </span>
                  <button
                    className="btn ghost"
                    type="button"
                    style={{ padding: '2px 8px' }}
                    onClick={() => void handleRevokeGrant(grant)}
                  >
                    {t('common.actions.remove')}
                  </button>
                </li>
              ))}
            </ul>
            <div>
              <button className="btn ghost" type="button" onClick={() => void handleClearGrants()}>
                {t('settings.artifactSecurity.grants.clearAll')}
              </button>
            </div>
          </>
        )}
      </div>
      <div className="status-item">
        <span style={{ color: 'var(--ink-3)', fontSize: 'var(--fs-xl)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          {t('settings.artifactSecurity.siteData.label')}
        </span>
        <span style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {t('settings.artifactSecurity.siteData.hint')}
        </span>
        {siteDataStatus && (
          <span
            role={siteDataStatus.ok ? 'status' : 'alert'}
            style={{ fontSize: 'var(--fs-xl)', color: siteDataStatus.ok ? 'var(--ink-3)' : 'var(--err)' }}
          >
            {siteDataStatus.ok
              ? t('settings.artifactSecurity.siteData.cleared')
              : t('settings.artifactSecurity.siteData.failed')}
          </span>
        )}
        <div>
          <button
            className="btn ghost"
            type="button"
            disabled={siteDataBusy}
            onClick={() => setSiteDataConfirmOpen(true)}
          >
            {t('settings.artifactSecurity.siteData.clearAll')}
          </button>
        </div>
      </div>
      <ConfirmDialog
        open={siteDataConfirmOpen}
        title={t('settings.artifactSecurity.siteData.confirmTitle')}
        description={t('settings.artifactSecurity.siteData.confirmDescription')}
        confirmLabel={t('settings.artifactSecurity.siteData.confirm')}
        cancelLabel={t('common.actions.cancel')}
        onCancel={() => setSiteDataConfirmOpen(false)}
        onConfirm={() => void handleClearSiteData()}
      />
      <div className="status-item">
        <span style={{ color: 'var(--ink-3)', fontSize: 'var(--fs-xl)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          {t('settings.artifactSecurity.allowlist.label')}
        </span>
        <span style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {t('settings.artifactSecurity.allowlist.hint')}
        </span>
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <input
            value={allowlistInput}
            onChange={(e) => setAllowlistInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
            placeholder={t('settings.artifactSecurity.allowlist.inputPlaceholder')}
            style={{ flex: 1, borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xl)' }}
          />
          <button className="btn" type="button" onClick={handleAdd}>
            {t('settings.artifactSecurity.actions.add')}
          </button>
        </div>
        {settings.artifactRemoteAllowlist.length === 0 ? (
          <span style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-3)' }}>{t('settings.artifactSecurity.allowlist.empty')}</span>
        ) : (
          <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 4 }}>
            {settings.artifactRemoteAllowlist.map((origin) => (
              <li key={origin} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--fs-xl)', fontFamily: 'var(--font-mono)' }}>
                <span style={{ flex: 1, wordBreak: 'break-all' }}>{origin}</span>
                <button
                  className="btn ghost"
                  type="button"
                  style={{ padding: '2px 8px' }}
                  onClick={() => handleRemove(origin)}
                >
                  {t('common.actions.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <span style={{ fontSize: 'var(--fs-md)', color: 'var(--ink-3)' }}>{t('settings.artifactSecurity.allowlist.validationHint')}</span>
      </div>
    </div>
  );
}
