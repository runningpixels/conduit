import { useState } from 'react';
import type { AppSettings, WebSearchMode } from '@conduit/config-schema';
import type { WebSearchDefaults } from '@conduit/config-schema';
import { WebSearchConsentDialog } from './WebSearchConsentDialog';
import { appName } from '../../brand';
import { resolveSearchBackend } from '../../chat/webSearchIntent';

interface WebSearchSectionProps {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}

const MODE_OPTIONS: { value: WebSearchMode; label: string; help: string }[] = [
  {
    value: 'auto',
    label: 'Auto',
    help: 'Provider-hosted when available (OpenAI, Gemini); otherwise DuckDuckGo from this machine.',
  },
  {
    value: 'hosted',
    label: 'Provider',
    help: 'Always use the model provider’s hosted search. Unsupported endpoints show “Web search unavailable”.',
  },
  {
    value: 'local',
    label: 'Local',
    help: 'Always use DuckDuckGo Instant Answer from this machine. Queries are not sent to the model provider.',
  },
];

/** Web Search settings: master toggle, search source, hosted knobs, consent. */
export function WebSearchSection({ settings, onUpdate, onStatus }: WebSearchSectionProps) {
  const ws = settings.webSearch;
  const disabled = settings.localOnly;
  const [showConsent, setShowConsent] = useState(false);
  const [pendingConsentState, setPendingConsentState] = useState<AppSettings | null>(null);

  const mode = ws.mode ?? 'auto';
  const resolvedBackend = resolveSearchBackend(
    mode,
    settings.activeProvider,
    settings.providerEndpoints,
  );
  // Hosted-only knobs (context size, domains, …) only apply when the turn
  // would actually use provider-hosted search.
  const hostedKnobsDisabled = resolvedBackend === 'local';

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
      onStatus(`Domain list exceeds 100 entries (provider cap). Please remove ${entries.length - 100} entries.`);
      return;
    }
    patchDefaults({ [field]: entries });
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Web Search</span>
      </div>
      <p style={{ marginBottom: 12, fontSize: '12px', color: 'var(--ink-2)' }}>
        When enabled, the model can look things up on the internet during a conversation.
        Use <strong>Search source</strong> to choose provider-hosted search or {appName()}’s
        DuckDuckGo builtin. The chat-bar search icon turns search on for the conversation
        until you turn it off.
      </p>

      {disabled && (
        <p style={{ marginBottom: 12, fontSize: '12px', color: 'var(--warn)' }}>
          Web search is unavailable in local-only mode. Disable local-only mode to enable web search.
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
          Enable web search
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
              Search source
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
                    <strong>{opt.label}</strong>
                    <span style={{ display: 'block', fontSize: '11px', color: 'var(--ink-3)', marginTop: 2 }}>
                      {opt.help}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <p style={{ margin: '6px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
              Current provider ({settings.activeProvider}): would use{' '}
              <strong>{resolvedBackend === 'hosted' ? 'provider-hosted' : 'DuckDuckGo (local)'}</strong> search.
            </p>
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
                Provider search options apply only when the search source resolves to provider-hosted.
              </p>
            )}

            {/* Search context size */}
            <div>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                Search context size
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
                    {size.charAt(0).toUpperCase() + size.slice(1)}
                  </label>
                ))}
              </div>
              <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
                How much search-result context the model sees. Low = simple lookups; High = research-heavy queries.
              </p>
            </div>

            {/* External web access */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={ws.externalWebAccess}
                onChange={(e) => patchDefaults({ externalWebAccess: e.target.checked })}
              />
              Live internet access
            </label>
            <p style={{ margin: '-8px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
              Unchecked = cache-only / offline mode. Provider ignores this for some models.
            </p>

            {/* Returned-token budget */}
            <div>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                Returned-token budget
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
                    {budget.charAt(0).toUpperCase() + budget.slice(1)}
                  </label>
                ))}
              </div>
              <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
                Unlimited removes the returned-token cap for long research runs. GPT-5+ reasoning models only.
              </p>
            </div>

            {/* Allowed domains */}
            <div>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                Allowed domains
              </span>
              <textarea
                value={ws.allowedDomains.join('\n')}
                onChange={(e) => handleDomainListChange('allowedDomains', e.target.value)}
                placeholder="pubmed.ncbi.nlm.nih.gov&#10;www.cdc.gov"
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
                One bare domain per line (no http(s) prefix). Max 100 entries. Leave empty for unfiltered search.
              </p>
            </div>

            {/* Blocked domains */}
            <div>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                Blocked domains
              </span>
              <textarea
                value={ws.blockedDomains.join('\n')}
                onChange={(e) => handleDomainListChange('blockedDomains', e.target.value)}
                placeholder="reddit.com&#10;quora.com"
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
                One bare domain per line. Max 100 entries.
              </p>
            </div>

            {/* User location */}
            <div>
              <span style={{ fontSize: '12px', color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                Approximate user location
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
                  placeholder="GB"
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
                  placeholder="London (optional)"
                  style={{ flex: 1, minWidth: '8em', fontSize: '12px' }}
                />
              </div>
              <p style={{ margin: '4px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
                ISO 3166-1 alpha-2 country code. Used to localize search results. Approximate — not stored server-side by {appName()}.
              </p>
            </div>

            {/* Include sources */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
              <input
                type="checkbox"
                checked={ws.includeSources}
                onChange={(e) => patchDefaults({ includeSources: e.target.checked })}
              />
              Show source list in search results
            </label>
            <p style={{ margin: '-8px 0 0', fontSize: '11px', color: 'var(--ink-3)' }}>
              When on, the provider returns the raw source list alongside citations. May increase response size.
            </p>
          </fieldset>
        </fieldset>
      </div>
    </div>
  );
}
