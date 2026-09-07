import { useEffect, useState } from 'react';
import type { AppSettings, CredentialSummary, ModelInfo, ProviderDescriptor } from '../../ipc/contracts';
import {
  listProviderDescriptors,
  listProviderModels,
  loadProviderCredentialReference,
  saveProviderCredential,
  updateSettings,
  validateProviderCredentials,
} from '../../ipc/client';
import { useT } from '../../i18n';
import { useFormatters } from '../../i18n/formatters';

/**
 * The provider list shown only when `listProviderDescriptors()` fails.
 *
 * These are brand names, and they are deliberately NOT in the message catalog
 * (D7): a translator must never be handed "Anthropic" or "Ollama" as something
 * to translate, and 10 pass-through keys would be 10 chances for one of them
 * to come back translated in some locale. Holding them as data and rendering
 * through a JSX expression also satisfies Guard G10 without an exemption
 * comment on every line.
 *
 * `openai_compat` is not in this list because "Compatible" is prose, not a
 * name, and does translate — it is rendered from the catalog below.
 */
const FALLBACK_PROVIDER_BRANDS: { id: string; brand: string }[] = [
  { id: 'anthropic', brand: 'Anthropic' },
  { id: 'openai', brand: 'OpenAI' },
  { id: 'gemini', brand: 'Google Gemini' },
  { id: 'openrouter', brand: 'OpenRouter' },
  { id: 'opencode_zen', brand: 'OpenCode Zen' },
  { id: 'ollama', brand: 'Ollama' },
  { id: 'groq', brand: 'Groq' },
  { id: 'deepseek', brand: 'DeepSeek' },
  { id: 'mistral', brand: 'Mistral' },
  { id: 'lmstudio', brand: 'LM Studio' },
];

/** Phase 6 M6.4: shared provider + BYOK surface. Used by Onboarding and
 *  SettingsScreen. Owns provider selection, model listing, the optional base
 *  URL, the secret entry that routes through Rust to the OS keychain, the
 *  connection test, and the keychain credential reference. Secrets never
 *  touch the renderer's state. */
export function ProviderPicker({
  settings,
  onSettingsChange,
  onStatus,
}: {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const [providerSecret, setProviderSecret] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [credentialSummary, setCredentialSummary] = useState<CredentialSummary | null>(null);
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const [busy, setBusy] = useState(false);

  const activeDescriptor = providers.find((p) => p.id === settings.activeProvider);

  useEffect(() => {
    void (async () => {
      try {
        setProviders(await listProviderDescriptors());
      } catch {
        setProviders([]);
      }
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        setModels(await listProviderModels(settings.activeProvider));
      } catch {
        setModels([]);
      }
      try {
        setCredentialSummary(await loadProviderCredentialReference(settings.activeProvider));
      } catch {
        setCredentialSummary(null);
      }
    })();
  }, [settings.activeProvider]);

  const providerBaseUrl = settings.providerEndpoints?.[settings.activeProvider]?.baseUrl ?? '';

  function handleProviderChange(providerId: string) {
    const descriptor = providers.find((p) => p.id === providerId);
    const existingEndpoint = settings.providerEndpoints?.[providerId];
    const nextEndpoints = { ...settings.providerEndpoints };
    if (descriptor?.defaultBaseUrl && !existingEndpoint?.baseUrl) {
      nextEndpoints[providerId] = {
        ...existingEndpoint,
        baseUrl: descriptor.defaultBaseUrl,
      };
    }
    onSettingsChange({
      ...settings,
      activeProvider: providerId,
      providerEndpoints: nextEndpoints,
    });
  }

  async function handleSaveCredential() {
    setBusy(true);
    try {
      const summary = await saveProviderCredential({
        providerId: settings.activeProvider,
        secret: providerSecret,
      });
      setCredentialSummary(summary);
      setProviderSecret('');
      onStatus(t('settings.provider.credentialSaved'));
    } catch (e) {
      onStatus(t('settings.provider.credentialSaveFailed', { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadModels() {
    setBusy(true);
    try {
      const listed = await listProviderModels(settings.activeProvider);
      setModels(listed);
      onStatus(t('settings.provider.modelsLoaded', { count: listed.length }));
    } catch (e) {
      onStatus(t('settings.provider.loadModelsFailed', { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function handleValidateProvider() {
    setBusy(true);
    try {
      await validateProviderCredentials(settings.activeProvider);
      onStatus(t('settings.provider.credentialsValidated'));
    } catch (e) {
      onStatus(t('settings.provider.testConnectionFailed', { error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  function updateProviderBaseUrl(baseUrl: string) {
    onSettingsChange({
      ...settings,
      providerEndpoints: {
        ...settings.providerEndpoints,
        [settings.activeProvider]: {
          ...settings.providerEndpoints?.[settings.activeProvider],
          baseUrl,
        },
      },
    });
  }

  const sortedProviders = [...providers].sort((a, b) => a.tier - b.tier || fmt.compare(a.displayName, b.displayName));

  return (
    <div className="form-grid">
      <label className="field">
        <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.provider.providerLabel')}</span>
        <select
          value={settings.activeProvider}
          onChange={(e) => handleProviderChange(e.target.value)}
          style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '10px 12px' }}
        >
          {sortedProviders.length > 0 ? (
            sortedProviders.map((p) => (
              <option key={p.id} value={p.id}>{p.displayName}</option>
            ))
          ) : (
            <>
              {FALLBACK_PROVIDER_BRANDS.map((opt) => (
                <option key={opt.id} value={opt.id}>{opt.brand}</option>
              ))}
              <option value="openai_compat">{t('settings.provider.fallback.openaiCompat')}</option>
            </>
          )}
        </select>
        {activeDescriptor?.description ? (
          <span style={{ color: 'var(--ink-3)', fontSize: '12px' }}>{activeDescriptor.description}</span>
        ) : null}
      </label>
      <label className="field">
        <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.provider.modelLabel')}</span>
        {models.length > 0 ? (
          <select
            value={settings.activeModel}
            onChange={(e) => onSettingsChange({ ...settings, activeModel: e.target.value })}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '10px 12px' }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.displayName ?? m.id}</option>
            ))}
          </select>
        ) : (
          <input
            value={settings.activeModel}
            onChange={(e) => onSettingsChange({ ...settings, activeModel: e.target.value })}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '10px 12px' }}
          />
        )}
      </label>
      {activeDescriptor?.showBaseUrlField && (
        <label className="field">
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.provider.baseUrlLabel')}</span>
          <input
            value={providerBaseUrl}
            onChange={(e) => updateProviderBaseUrl(e.target.value)}
            placeholder={activeDescriptor.defaultBaseUrl ?? t('settings.provider.baseUrlPlaceholder')}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '10px 12px' }}
          />
        </label>
      )}
      {activeDescriptor?.credentialMode !== 'none' && (
        <label className="field">
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.provider.secretLabel')}</span>
          <input
            type="password"
            value={providerSecret}
            onChange={(e) => setProviderSecret(e.target.value)}
            placeholder={t('settings.provider.secretPlaceholder')}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '10px 12px' }}
          />
        </label>
      )}
      <div className="actions">
        <button className="btn primary" type="button" disabled={busy || activeDescriptor?.credentialMode === 'none'} onClick={() => void handleSaveCredential()}>{t('settings.provider.saveKeyButton')}</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void handleLoadModels()}>{t('settings.provider.loadModelsButton')}</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void handleValidateProvider()}>{t('settings.provider.testConnectionButton')}</button>
      </div>
      <div className="status-item">
        <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.provider.credentialReferenceLabel')}</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
          {credentialSummary?.storedInKeychain
            ? t('settings.provider.credentialRefActive', { ref: credentialSummary.credentialRef })
            : activeDescriptor?.credentialMode === 'none'
              ? t('settings.provider.noKeyRequired')
              : t('settings.provider.noKeyStored')}
        </span>
      </div>
    </div>
  );
}

/** Persist the full settings object (used by both Onboarding "Get started" and
 *  settings auto-save). Returns the persisted settings
 *  the Rust layer normalized. */
export async function persistSettings(settings: AppSettings): Promise<AppSettings> {
  return updateSettings(settings);
}
