import { useState } from 'react';
import type { AppSettings, MigrationRecoveryInfo } from '../ipc/contracts';
import { getOnboardingState, updateSettings } from '../ipc/client';
import { ProviderPicker } from '../workspace/settings/ProviderPicker';
import { ConnectorsSection } from '../workspace/SettingsPanel';

/** Phase 6 M6.4: first-run onboarding — the BYOK gate. Full-screen route (not a
 *  modal) shown by `App.tsx` while `onboardingCompleted` is false or no provider
 *  credential is configured. Reuses the shared `ProviderPicker` (provider + BYOK
 *  entry via the OS keychain) and `ConnectorsSection` so it does not duplicate
 *  the SettingsPanel flows. Steps: welcome + privacy → provider/BYOK → optional
 *  connectors → diagnostics awareness → "Get started". The hard gate is a
 *  configured provider (chat is useless without one); connectors + diagnostics
 *  are optional. */
export function Onboarding({
  settings,
  onSettingsChange,
  onStatus,
  onComplete,
}: {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  onStatus: (message: string) => void;
  onComplete: () => void;
}) {
  const [finishing, setFinishing] = useState(false);

  async function handleFinish() {
    setFinishing(true);
    try {
      // Hard gate: re-probe the keychain before closing. Ollama counts as
      // satisfied-by-config; otherwise a BYOK provider needs a stored secret.
      const probe = await getOnboardingState();
      if (!probe.hasProviderCredential) {
        onStatus('Add a provider key (or pick Ollama) before continuing.');
        return;
      }
      const next = await updateSettings({ ...settings, onboardingCompleted: true });
      onSettingsChange(next);
      onStatus('Welcome to Conduit');
      onComplete();
    } catch (e) {
      onStatus(`Could not finish onboarding: ${String(e)}`);
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="app" id="app" style={{ display: 'grid', placeItems: 'center', padding: 24, overflow: 'auto' }}>
      <div className="info-card" style={{ maxWidth: 680, width: '100%' }}>
        <h2 style={{ marginBottom: 4 }}>Welcome to Conduit</h2>
        <p style={{ color: 'var(--text-2)', marginBottom: 16, lineHeight: 1.5 }}>
          Conduit is local-first: your conversations, attachments, and artifacts stay on
          this machine. Provider credentials live in the OS keychain — never in plain
          settings. There is no background telemetry; update checks are opt-in and you
          will always be asked before an update is applied.
        </p>

        <h3 style={{ fontSize: 14, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '8px 0' }}>
          1 · Choose a provider and bring your key
        </h3>
        <ProviderPicker settings={settings} onSettingsChange={onSettingsChange} onStatus={onStatus} />
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8, lineHeight: 1.5 }}>
          Pick Anthropic/OpenAI and paste an API key, choose OpenAI-Compatible with your
          endpoint, or pick Ollama to run against a local model (no key needed).
        </p>

        <h3 style={{ fontSize: 14, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 8px' }}>
          2 · Connectors (optional)
        </h3>
        <p style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, marginBottom: 8 }}>
          Add local stdio connectors to give the assistant tools. You can skip this and
          set it up later in Settings.
        </p>
        <ConnectorsSection onStatus={onStatus} />

        <h3 style={{ fontSize: 14, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.08em', margin: '16px 0 8px' }}>
          3 · Diagnostics
        </h3>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={settings.diagnosticsEnabled}
            onChange={(e) => onSettingsChange({ ...settings, diagnosticsEnabled: e.target.checked })}
          />
          Enable diagnostics export
        </label>
        <p style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, marginTop: 6 }}>
          When enabled, you can export a support bundle from Settings. It contains only
          redacted paths and your active provider/model/toggles/theme — never secrets,
          base URLs, allowlists, or conversation content. You will see a one-time
          disclosure before the first export.
        </p>

        <div className="actions" style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button className="btn primary" type="button" disabled={finishing} onClick={() => void handleFinish()}>
            {finishing ? 'Starting…' : 'Get started'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Phase 6 M6.4: migration-recovery notice, shown with priority over onboarding
 *  when a startup migration failed and the live DB was rolled back to a fresh
 *  store (with a `.corrupt-<unix>.bak` backup). */
export function MigrationRecoveryNotice({
  recovery,
  onStatus,
}: {
  recovery: MigrationRecoveryInfo;
  onStatus: (message: string) => void;
}) {
  void onStatus;
  return (
    <div className="app" id="app" style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
      <div className="info-card" style={{ maxWidth: 560, width: '100%' }}>
        <h2 style={{ marginBottom: 8 }}>Conduit could not upgrade your local data</h2>
        <p style={{ color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 12 }}>
          A database migration failed at startup. To keep the app usable, Conduit started
          with a fresh local store. Your previous data was backed up before the reset —
          it is untouched and you can recover from it manually.
        </p>
        <div className="status-item" style={{ display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
          <span style={{ color: 'var(--text-3)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '.08em' }}>Backup path</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-all' }}>{recovery.backupPath}</span>
          <span style={{ color: 'var(--text-3)', fontSize: 12, textTransform: 'uppercase', letterSpacing: '.08em', marginTop: 8 }}>Error</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, wordBreak: 'break-word' }}>{recovery.error}</span>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, marginTop: 12 }}>
          Export a diagnostics bundle from Settings and contact support. Restart Conduit
          to continue with the fresh store.
        </p>
        <div className="actions" style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn primary" type="button" onClick={() => window.location.reload()}>
            Restart
          </button>
        </div>
      </div>
    </div>
  );
}