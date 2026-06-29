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
      onStatus('Provider credential stored in keychain');
    } catch (e) {
      onStatus(`Save provider key failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleLoadModels() {
    setBusy(true);
    try {
      const listed = await listProviderModels(settings.activeProvider);
      setModels(listed);
      onStatus(`Loaded ${listed.length} models`);
    } catch (e) {
      onStatus(`Load models failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleValidateProvider() {
    setBusy(true);
    try {
      await validateProviderCredentials(settings.activeProvider);
      onStatus('Provider credentials validated');
    } catch (e) {
      onStatus(`Test connection failed: ${String(e)}`);
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

  const sortedProviders = [...providers].sort((a, b) => a.tier - b.tier || a.displayName.localeCompare(b.displayName));

  return (
    <div className="form-grid" style={{ display: 'grid', gap: 12 }}>
      <label className="field" style={{ display: 'grid', gap: 6 }}>
        <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Provider</span>
        <select
          value={settings.activeProvider}
          onChange={(e) => handleProviderChange(e.target.value)}
          style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
        >
          {sortedProviders.length > 0 ? (
            sortedProviders.map((p) => (
              <option key={p.id} value={p.id}>{p.displayName}</option>
            ))
          ) : (
            <>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="gemini">Google Gemini</option>
              <option value="openrouter">OpenRouter</option>
              <option value="opencode_zen">OpenCode Zen</option>
              <option value="ollama">Ollama</option>
              <option value="groq">Groq</option>
              <option value="deepseek">DeepSeek</option>
              <option value="mistral">Mistral</option>
              <option value="lmstudio">LM Studio</option>
              <option value="openai_compat">OpenAI Compatible</option>
            </>
          )}
        </select>
        {activeDescriptor?.description ? (
          <span style={{ color: 'var(--text-3)', fontSize: '12px' }}>{activeDescriptor.description}</span>
        ) : null}
      </label>
      <label className="field" style={{ display: 'grid', gap: 6 }}>
        <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Model</span>
        {models.length > 0 ? (
          <select
            value={settings.activeModel}
            onChange={(e) => onSettingsChange({ ...settings, activeModel: e.target.value })}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.displayName ?? m.id}</option>
            ))}
          </select>
        ) : (
          <input
            value={settings.activeModel}
            onChange={(e) => onSettingsChange({ ...settings, activeModel: e.target.value })}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
          />
        )}
      </label>
      {activeDescriptor?.showBaseUrlField && (
        <label className="field" style={{ display: 'grid', gap: 6 }}>
          <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Base URL</span>
          <input
            value={providerBaseUrl}
            onChange={(e) => updateProviderBaseUrl(e.target.value)}
            placeholder={activeDescriptor.defaultBaseUrl ?? 'https://your-endpoint.example/v1'}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
          />
        </label>
      )}
      {activeDescriptor?.credentialMode !== 'none' && (
        <label className="field" style={{ display: 'grid', gap: 6 }}>
          <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Provider secret</span>
          <input
            type="password"
            value={providerSecret}
            onChange={(e) => setProviderSecret(e.target.value)}
            placeholder="Stored only through Rust"
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
          />
        </label>
      )}
      <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn primary" type="button" disabled={busy || activeDescriptor?.credentialMode === 'none'} onClick={() => void handleSaveCredential()}>Save provider key</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void handleLoadModels()}>Load models</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void handleValidateProvider()}>Test connection</button>
      </div>
      <div className="status-item" style={{ display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
        <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Credential reference</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
          {credentialSummary?.storedInKeychain
            ? `${credentialSummary.credentialRef} (active provider)`
            : activeDescriptor?.credentialMode === 'none'
              ? 'No key required for this provider'
              : 'No key stored yet'}
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
