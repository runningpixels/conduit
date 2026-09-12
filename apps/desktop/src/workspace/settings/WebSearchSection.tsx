import { useEffect, useState } from 'react';
import type {
  AppSettings,
  CredentialSummary,
  LocalSearchBackend,
  WebSearchMode,
} from '@conduit/config-schema';
import type { WebSearchDefaults } from '@conduit/config-schema';
import { WebSearchConsentDialog } from './WebSearchConsentDialog';
import {
  SEARCH_CREDENTIAL_IDS,
  localSearchBackendLabel,
  localSearchBackendOf,
  resolveSearchBackend,
} from '../../chat/webSearchIntent';
import {
  loadProviderCredentialReference,
  saveProviderCredential,
} from '../../ipc/client';
import { useRichT, useT } from '../../i18n';

interface WebSearchSectionProps {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}

const MODE_OPTIONS: { value: WebSearchMode; labelId: string; helpId: string }[] = [
  {
    value: 'auto',
    labelId: 'settings.webSearch.mode.auto.label',
    helpId: 'settings.webSearch.mode.auto.help',
  },
  {
    value: 'hosted',
    labelId: 'settings.webSearch.mode.hosted.label',
    helpId: 'settings.webSearch.mode.hosted.help',
  },
  {
    value: 'local',
    labelId: 'settings.webSearch.mode.local.label',
    helpId: 'settings.webSearch.mode.local.help',
  },
];

const LOCAL_BACKEND_OPTIONS: { value: LocalSearchBackend; labelId: string; helpId: string }[] = [
  {
    value: 'duckduckgo',
    labelId: 'settings.webSearch.localBackend.duckduckgo.label',
    helpId: 'settings.webSearch.localBackend.duckduckgo.help',
  },
  {
    value: 'tavily',
    labelId: 'settings.webSearch.localBackend.tavily.label',
    helpId: 'settings.webSearch.localBackend.tavily.help',
  },
  {
    value: 'brave',
    labelId: 'settings.webSearch.localBackend.brave.label',
    helpId: 'settings.webSearch.localBackend.brave.help',
  },
  {
    value: 'searxng',
    labelId: 'settings.webSearch.localBackend.searxng.label',
    helpId: 'settings.webSearch.localBackend.searxng.help',
  },
];

const CONTEXT_SIZE_LABEL_IDS: Record<'low' | 'medium' | 'high', string> = {
  low: 'settings.webSearch.contextSize.low',
  medium: 'settings.webSearch.contextSize.medium',
  high: 'settings.webSearch.contextSize.high',
};

const TOKEN_BUDGET_LABEL_IDS: Record<'default' | 'unlimited', string> = {
  default: 'settings.webSearch.tokenBudget.default',
  unlimited: 'settings.webSearch.tokenBudget.unlimited',
};

/** Web Search settings: master toggle, search source, hosted knobs, consent. */
export function WebSearchSection({ settings, onUpdate, onStatus }: WebSearchSectionProps) {
  const t = useT();
  const tr = useRichT();
  const ws = settings.webSearch;
  const disabled = settings.localOnly;
  const [showConsent, setShowConsent] = useState(false);
  const [pendingConsentState, setPendingConsentState] = useState<AppSettings | null>(null);

  const mode = ws.mode ?? 'auto';
  const localBackend = localSearchBackendOf(ws.localBackend);
  const resolvedBackend = resolveSearchBackend(
    mode,
    settings.activeProvider,
    settings.providerEndpoints,
  );
  // Hosted-only knobs (context size, domains, …) only apply when the turn
  // would actually use provider-hosted search.
  const hostedKnobsDisabled = resolvedBackend === 'local';
  const searchTypeLabel =
    resolvedBackend === 'hosted'
      ? t('settings.webSearch.searchType.hosted')
      : t('settings.webSearch.searchType.local', { backend: localSearchBackendLabel(localBackend) });

  function patchDefaults(next: Partial<WebSearchDefaults>) {
    onUpdate({
      ...settings,
      webSearch: { ...ws, ...next },
    });
  }

  function handleDomainListChange(
    field: 'allowedDomains' | 'blockedDomains',
    raw: string,
  ) {
    const entries = raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (entries.length > 100) {
      onStatus(t('settings.webSearch.domainListTooLong', { count: entries.length - 100 }));
      return;
    }
    patchDefaults({ [field]: entries });
  }

  return (
    <div className="settings-section">
      <p style={{ marginBottom: 12, fontSize: '12px', color: 'var(--ink-2)' }}>
        {tr('settings.webSearch.intro')}
      </p>

      {disabled && (
        <p style={{ marginBottom: 12, fontSize: '12px', color: 'var(--warn)' }}>
          {t('settings.webSearch.localOnlyWarning')}
        </p>
      )}

      <div className="form-grid">
        {/* Master toggle — intercept with consent dialog on first enable */}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={settings.webSearchEnabled}
            disabled={disabled}
            onChange={(e) => {
              const nextVal = e.target.checked;
              if (nextVal && !settings.webSearchConsentAcknowledged) {
                setPendingConsentState({ ...settings, webSearchEnabled: true });
                setShowConsent(true);
              } else {
                onUpdate({ ...settings, webSearchEnabled: nextVal });
              }
            }}
          />
          {t('settings.webSearch.enableToggle.label')}
        </label>
        <WebSearchConsentDialog
          visible={showConsent}
          onAllow={() => {
            setShowConsent(false);
            if (pendingConsentState) {
              onUpdate({ ...pendingConsentState, webSearchConsentAcknowledged: true });
              setPendingConsentState(null);
            }
          }}
          onDeny={() => {
            setShowConsent(false);
            setPendingConsentState(null);
          }}
        />

        <fieldset
          disabled={!settings.webSearchEnabled || disabled}
          style={{
            border: 'none',
            padding: 0,
            margin: 0,
            display: 'grid',
            gap: 12,
            opacity: settings.webSearchEnabled && !disabled ? 1 : 0.5,
          }}
        >
          {/* Search source */}
          <div>
            <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
              {t('settings.webSearch.sourceHeading')}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              {MODE_OPTIONS.map((opt) => (
                <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: '13px' }}>
                  <input
                    type="radio"
                    name="webSearchMode"
                    checked={mode === opt.value}
                    onChange={() => patchDefaults({ mode: opt.value })}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <strong>{t(opt.labelId)}</strong>
                    <span style={{ display: 'block', fontSize: '11px', color: 'var(--ink-3)', marginTop: 2 }}>
                      {t(opt.helpId)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p style={{ margin: '6px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
              {tr('settings.webSearch.currentProviderSummary', {
                provider: settings.activeProvider,
                searchType: searchTypeLabel,
              })}
            </p>
          </div>

          {/* Local backend picker — used whenever a turn resolves to local. */}
          <div>
            <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
              {t('settings.webSearch.localBackendHeading')}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
              {LOCAL_BACKEND_OPTIONS.map((opt) => (
                <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: '13px' }}>
                  <input
                    type="radio"
                    name="localSearchBackend"
                    checked={localBackend === opt.value}
                    onChange={() => patchDefaults({ localBackend: opt.value })}
                    style={{ marginTop: 3 }}
                  />
                  <span>
                    <strong>{t(opt.labelId)}</strong>
                    <span style={{ display: 'block', fontSize: '11px', color: 'var(--ink-3)', marginTop: 2 }}>
                      {t(opt.helpId)}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {localBackend === 'tavily' && (
              <SearchBackendKeyField
                providerId={SEARCH_CREDENTIAL_IDS.tavily}
                label="Tavily"
                onStatus={onStatus}
              />
            )}
            {localBackend === 'brave' && (
              <SearchBackendKeyField
                providerId={SEARCH_CREDENTIAL_IDS.brave}
                label="Brave Search"
                onStatus={onStatus}
              />
            )}
            {localBackend === 'searxng' && (
              <>
                <label className="field" style={{ display: 'grid', gap: 4, marginTop: 10 }}>
                  <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{t('settings.webSearch.searxngBaseUrlLabel')}</span>
                  <input
                    type="url"
                    value={ws.searxngBaseUrl ?? ''}
                    onChange={(e) =>
                      patchDefaults({
                        searxngBaseUrl: e.target.value.trim() || undefined,
                      })
                    }
                    placeholder={t('settings.webSearch.searxngBaseUrlPlaceholder')}
                    style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                  />
                </label>
                <SearchBackendKeyField
                  providerId={SEARCH_CREDENTIAL_IDS.searxng}
                  label={t('settings.webSearch.searxngCredentialLabel')}
                  onStatus={onStatus}
                />
              </>
            )}
          </div>

          {/* Hosted-only knobs */}
          <fieldset
            disabled={hostedKnobsDisabled}
            style={{
              border: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: 12,
              opacity: hostedKnobsDisabled ? 0.5 : 1,
            }}
          >
            {hostedKnobsDisabled && (
              <p style={{ margin: 0, fontSize: '11px', color: 'var(--ink-3)' }}>
                {t('settings.webSearch.hostedOnlyNotice')}
              </p>
            )}

            {/* Search context size */}
            <div>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                {t('settings.webSearch.contextSize.heading')}
              </span>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                {(['low', 'medium', 'high'] as const).map((size) => (
                  <label key={size} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '13px' }}>
                    <input
                      type="radio"
                      name="searchContextSize"
                      checked={ws.searchContextSize === size}
                      onChange={() => patchDefaults({ searchContextSize: size })}
                    />
                    {t(CONTEXT_SIZE_LABEL_IDS[size])}
                  </label>
                ))}
              </div>
              <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
                {t('settings.webSearch.contextSize.help')}
              </p>
            </div>

            {/* External web access */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={ws.externalWebAccess}
                onChange={(e) => patchDefaults({ externalWebAccess: e.target.checked })}
              />
              {t('settings.webSearch.externalWebAccess.label')}
            </label>
            <p style={{ margin: '-8px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
              {t('settings.webSearch.externalWebAccess.help')}
            </p>

            {/* Returned-token budget */}
            <div>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                {t('settings.webSearch.tokenBudget.heading')}
              </span>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                {(['default', 'unlimited'] as const).map((budget) => (
                  <label key={budget} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '13px' }}>
                    <input
                      type="radio"
                      name="returnTokenBudget"
                      checked={ws.returnTokenBudget === budget}
                      onChange={() => patchDefaults({ returnTokenBudget: budget })}
                    />
                    {t(TOKEN_BUDGET_LABEL_IDS[budget])}
                  </label>
                ))}
              </div>
              <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
                {t('settings.webSearch.tokenBudget.help')}
              </p>
            </div>

            {/* Allowed domains */}
            <div>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                {t('settings.webSearch.allowedDomains.heading')}
              </span>
              <textarea
                value={ws.allowedDomains.join('\n')}
                onChange={(e) => handleDomainListChange('allowedDomains', e.target.value)}
                placeholder={t('settings.webSearch.allowedDomains.placeholder')}
                rows={3}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                  marginTop: 4,
                  resize: 'vertical',
                }}
              />
              <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
                {t('settings.webSearch.allowedDomains.help')}
              </p>
            </div>

            {/* Blocked domains */}
            <div>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                {t('settings.webSearch.blockedDomains.heading')}
              </span>
              <textarea
                value={ws.blockedDomains.join('\n')}
                onChange={(e) => handleDomainListChange('blockedDomains', e.target.value)}
                placeholder={t('settings.webSearch.blockedDomains.placeholder')}
                rows={3}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                  marginTop: 4,
                  resize: 'vertical',
                }}
              />
              <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
                {t('settings.webSearch.blockedDomains.help')}
              </p>
            </div>

            {/* User location */}
            <div>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                {t('settings.webSearch.userLocation.heading')}
              </span>
              <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                <input
                  type="text"
                  value={ws.userLocation?.country ?? ''}
                  onChange={(e) => {
                    const val = e.target.value.trim().toUpperCase();
                    if (val.length > 2) return;
                    patchDefaults({
                      userLocation: val
                        ? { country: val, city: ws.userLocation?.city, region: ws.userLocation?.region }
                        : undefined,
                    });
                  }}
                  placeholder={t('settings.webSearch.userLocation.countryPlaceholder')}
                  maxLength={2}
                  style={{ width: '4em', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
                />
                <input
                  type="text"
                  value={ws.userLocation?.city ?? ''}
                  onChange={(e) => {
                    const city = e.target.value.trim() || undefined;
                    if (!ws.userLocation) return;
                    patchDefaults({ userLocation: { ...ws.userLocation, city } });
                  }}
                  placeholder={t('settings.webSearch.userLocation.cityPlaceholder')}
                  style={{ flex: 1, minWidth: '8em', fontSize: '12px' }}
                />
              </div>
              <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
                {t('settings.webSearch.userLocation.help')}
              </p>
            </div>

            {/* Include sources */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={ws.includeSources}
                onChange={(e) => patchDefaults({ includeSources: e.target.checked })}
              />
              {t('settings.webSearch.includeSources.label')}
            </label>
            <p style={{ margin: '-8px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
              {t('settings.webSearch.includeSources.help')}
            </p>
          </fieldset>
        </fieldset>
      </div>
    </div>
  );
}

function SearchBackendKeyField({
  providerId,
  label,
  onStatus,
}: {
  providerId: string;
  label: string;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const [secret, setSecret] = useState('');
  const [summary, setSummary] = useState<CredentialSummary | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadProviderCredentialReference(providerId)
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [providerId]);

  async function handleSave() {
    setBusy(true);
    try {
      const next = await saveProviderCredential({ providerId, secret });
      setSummary(next);
      setSecret('');
      onStatus(t('settings.webSearch.credentialField.saved', { label }));
    } catch (e) {
      onStatus(t('settings.webSearch.credentialField.saveFailed', { label, error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="form-grid" style={{ marginTop: 10 }}>
      <label className="field" style={{ display: 'grid', gap: 4 }}>
        <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{t('settings.webSearch.credentialField.label', { label })}</span>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={t('settings.webSearch.credentialField.placeholder')}
          style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}
        />
      </label>
      <button
        className="btn primary"
        type="button"
        disabled={busy || !secret}
        onClick={() => void handleSave()}
      >
        {t('settings.webSearch.credentialField.saveButton', { label })}
      </button>
      <div className="status-item">
        <span>{t('settings.webSearch.credentialField.referenceLabel')}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
          {summary?.storedInKeychain || summary?.credentialRef
            ? summary.credentialRef
            : t('settings.webSearch.credentialField.noKeyStored')}
        </span>
      </div>
    </div>
  );
}
