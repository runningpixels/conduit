import { useEffect, useState } from 'react';
import type { AppSettings, CredentialSummary, ModelInfo } from '../../ipc/contracts';
import {
  listProviderModels,
  loadProviderCredentialReference,
  saveProviderCredential,
  updateSettings,
  validateProviderCredentials,
} from '../../ipc/client';

/** Phase 6 M6.4: shared provider + BYOK surface, extracted from `SettingsPanel`
 *  so the first-run `Onboarding` reuses it instead of duplicating the flow.
 *  Owns provider selection, model listing, the optional base URL, the secret
 *  entry that routes through Rust to the OS keychain, the connection test, and
 *  the keychain credential reference. The trust boundary is preserved — secrets
 *  never touch the renderer's state. */
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

  async function handleSaveCredential() {
    const summary = await saveProviderCredential({
      providerId: settings.activeProvider,
      secret: providerSecret,
    });
    setCredentialSummary(summary);
    setProviderSecret('');
    onStatus('Provider credential stored in keychain');
  }

  async function handleLoadModels() {
    const listed = await listProviderModels(settings.activeProvider);
    setModels(listed);
    onStatus(`Loaded ${listed.length} models`);
  }

  async function handleValidateProvider() {
    await validateProviderCredentials(settings.activeProvider);
    onStatus('Provider credentials validated');
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

  return (
    <div className="form-grid" style={{ display: 'grid', gap: 12 }}>
      <label className="field" style={{ display: 'grid', gap: 6 }}>
        <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Provider</span>
        <select
          value={settings.activeProvider}
          onChange={(e) => onSettingsChange({ ...settings, activeProvider: e.target.value })}
          style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
        >
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
          <option value="openai_compat">OpenAI Compatible</option>
          <option value="ollama">Ollama</option>
        </select>
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
      {providerNeedsBaseUrl(settings.activeProvider) && (
        <label className="field" style={{ display: 'grid', gap: 6 }}>
          <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Base URL</span>
          <input
            value={providerBaseUrl}
            onChange={(e) => updateProviderBaseUrl(e.target.value)}
            placeholder={settings.activeProvider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://your-endpoint.example/v1'}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
          />
        </label>
      )}
      {settings.activeProvider !== 'ollama' && (
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
        <button className="btn primary" type="button" onClick={() => void handleSaveCredential()}>Save provider key</button>
        <button className="btn" type="button" onClick={() => void handleLoadModels()}>Load models</button>
        <button className="btn" type="button" onClick={() => void handleValidateProvider()}>Test connection</button>
      </div>
      <div className="status-item" style={{ display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
        <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Credential reference</span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
          {credentialSummary?.storedInKeychain
            ? `${credentialSummary.credentialRef} (active provider)`
            : 'No key stored yet'}
        </span>
      </div>
    </div>
  );
}

function providerNeedsBaseUrl(providerId: string): boolean {
  return providerId === 'openai_compat' || providerId === 'ollama';
}

/** Persist the full settings object (used by both Onboarding "Get started" and
 *  the SettingsPanel "Persist settings" button). Returns the persisted settings
 *  the Rust layer normalized. */
export async function persistSettings(settings: AppSettings): Promise<AppSettings> {
  return updateSettings(settings);
}