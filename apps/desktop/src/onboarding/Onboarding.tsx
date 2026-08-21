import { useState } from 'react';
import type { AppSettings, MigrationRecoveryInfo, WipeScope } from '../ipc/contracts';
import type { StatusState } from '../chat/statusTypes';
import {
  acknowledgeMigrationRecovery,
  discardMigrationBackup,
  getOnboardingState,
  requestLocalDataWipe,
  restartApp,
  updateSettings,
} from '../ipc/client';
import { ProviderPicker } from '../workspace/settings/ProviderPicker';
import { ConnectorsSection } from '../workspace/settings/ConnectorsSection';

type OnboardingStep = 'provider' | 'connectors' | 'finish';

const STEPS: { id: OnboardingStep; label: string }[] = [
  { id: 'provider', label: 'Provider' },
  { id: 'connectors', label: 'Connectors' },
  { id: 'finish', label: 'Finish' },
];

/** Phase 6 M6.4: first-run onboarding — the BYOK gate. Full-screen route (not a
 *  modal) shown by `App.tsx` while `onboardingCompleted` is false or no provider
 *  credential is configured. Reuses the shared `ProviderPicker` (provider + BYOK
 *  entry via the OS keychain) and `ConnectorsSection` so it does not duplicate
 *  the Settings screen flows. Steps: provider/BYOK → optional connectors →
 *  diagnostics awareness → "Get started". The hard gate is a configured provider
 *  (chat is useless without one); connectors + diagnostics are optional. */
export function Onboarding({
  settings,
  onSettingsChange,
  onStatus,
  status,
  onComplete,
}: {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  onStatus: (message: string) => void;
  // Current status (owned by App). Rendered here so success/error messages
  // from every onboarding action are actually visible instead of swallowed.
  status: StatusState | null;
  onComplete: () => void;
}) {
  const [finishing, setFinishing] = useState(false);
  const [step, setStep] = useState<OnboardingStep>('provider');
  const stepIndex = STEPS.findIndex((s) => s.id === step);

  async function handleFinish() {
    setFinishing(true);
    try {
      // Hard gate: re-probe the keychain before closing. Ollama counts as
      // satisfied-by-config; otherwise a BYOK provider needs a stored secret.
      const probe = await getOnboardingState();
      if (!probe.hasProviderCredential) {
        onStatus('Add a provider key (or pick Ollama) before continuing.');
        setStep('provider');
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

  function goNext() {
    if (stepIndex < STEPS.length - 1) setStep(STEPS[stepIndex + 1].id);
  }

  function goBack() {
    if (stepIndex > 0) setStep(STEPS[stepIndex - 1].id);
  }

  return (
    <div className="app onboarding-shell" id="app">
      <div className="info-card onboarding-card">
        <h2>Welcome to Conduit</h2>
        <p className="onboarding-lede">
          Conduit is local-first: your conversations, attachments, and artifacts stay on
          this machine. Provider credentials live in the OS keychain — never in plain
          settings. There is no background telemetry; update checks are opt-in and you
          will always be asked before an update is applied.
        </p>

        <nav className="onboarding-steps" aria-label="Onboarding progress">
          {STEPS.map((s, i) => {
            const done = i < stepIndex;
            const active = s.id === step;
            return (
              <button
                key={s.id}
                type="button"
                className={`onboarding-step-dot${active ? ' active' : ''}${done ? ' done' : ''}`}
                aria-current={active ? 'step' : undefined}
                onClick={() => setStep(s.id)}
              >
                {i + 1} · {s.label}
              </button>
            );
          })}
        </nav>

        {step === 'provider' && (
          <section className="onboarding-step-body" aria-label="Choose a provider">
            <h3 className="onboarding-step-title">Choose a provider and bring your key</h3>
            <ProviderPicker settings={settings} onSettingsChange={onSettingsChange} onStatus={onStatus} />
            <p className="onboarding-hint">
              Pick Anthropic/OpenAI and paste an API key, choose OpenAI-Compatible with your
              endpoint, or pick Ollama to run against a local model (no key needed).
            </p>
          </section>
        )}

        {step === 'connectors' && (
          <section className="onboarding-step-body" aria-label="Connectors">
            <h3 className="onboarding-step-title">Connectors (optional)</h3>
            <p className="onboarding-hint">
              Add local stdio connectors to give the assistant tools. You can skip this and
              set it up later in Settings.
            </p>
            <ConnectorsSection onStatus={onStatus} />
          </section>
        )}

        {step === 'finish' && (
          <section className="onboarding-step-body" aria-label="Diagnostics and finish">
            <h3 className="onboarding-step-title">Diagnostics</h3>
            <label className="onboarding-check">
              <input
                type="checkbox"
                checked={settings.diagnosticsEnabled}
                onChange={(e) => onSettingsChange({ ...settings, diagnosticsEnabled: e.target.checked })}
              />
              Enable diagnostics export
            </label>
            <p className="onboarding-hint">
              When enabled, you can export a support bundle from Settings. It contains only
              redacted paths and your active provider/model/toggles/theme — never secrets,
              base URLs, allowlists, or conversation content. You will see a one-time
              disclosure before the first export.
            </p>
          </section>
        )}

        <div className="actions onboarding-actions">
          {stepIndex > 0 && (
            <button className="btn ghost" type="button" onClick={goBack}>
              Back
            </button>
          )}
          {step !== 'finish' ? (
            <button className="btn primary" type="button" onClick={goNext}>
              Continue
            </button>
          ) : (
            <button className="btn primary" type="button" disabled={finishing} onClick={() => void handleFinish()}>
              {finishing ? 'Starting…' : 'Get started'}
            </button>
          )}
        </div>

        {status && (
          <div role="status" aria-live="polite" className="status-item onboarding-status">
            {status.brief}
          </div>
        )}
      </div>
    </div>
  );
}

/** Phase 6 M6.4: migration-recovery notice, shown with priority over onboarding
 *  when a startup migration failed and the live DB was rolled back to a fresh
 *  store (with a `.corrupt-<unix>.bak` backup).
 *
 *  This screen is a dead end if it has no way out, so it has three:
 *  **Continue** dismisses the notice for this session (the backup stays put),
 *  **Restart Conduit** restarts the real process, and **Delete data** clears
 *  the backup or the whole local store. The original single "Restart" button
 *  called `window.location.reload()`, which reloads the webview but leaves the
 *  Rust process — and the `migration_recovery` it captured at startup —
 *  untouched, so the dialog came straight back and the user was trapped. */
export function MigrationRecoveryNotice({
  recovery,
  onStatus,
  onDismissed,
}: {
  recovery: MigrationRecoveryInfo;
  onStatus: (message: string) => void;
  /** Called after the notice is cleared, so `App` can re-read onboarding state
   *  and route the user into the workspace. */
  onDismissed: () => void;
}) {
  const [busy, setBusy] = useState<null | 'continue' | 'restart' | 'discard' | 'wipe'>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [scope, setScope] = useState<WipeScope>('conversations');
  const [confirmed, setConfirmed] = useState(false);

  async function run(kind: NonNullable<typeof busy>, action: () => Promise<void>) {
    setBusy(kind);
    try {
      await action();
    } catch (e) {
      onStatus(`Could not complete that: ${String(e)}`);
      setBusy(null);
    }
  }

  const handleContinue = () =>
    run('continue', async () => {
      await acknowledgeMigrationRecovery();
      onDismissed();
    });

  // No `setBusy(null)` on success: the process is on its way out, and leaving
  // the buttons disabled stops a second click from queueing another restart.
  const handleRestart = () => run('restart', restartApp);

  const handleDiscardBackup = () =>
    run('discard', async () => {
      const report = await discardMigrationBackup();
      onStatus(
        report.removedPaths.length
          ? `Deleted ${report.removedPaths.length} backup file(s), freeing ${formatBytes(report.freedBytes)}.`
          : 'No backup files were left to delete.',
      );
      onDismissed();
    });

  const handleWipe = () =>
    run('wipe', async () => {
      await requestLocalDataWipe(scope);
      await restartApp();
    });

  return (
    <div className="app onboarding-shell" id="app">
      <div className="info-card onboarding-card">
        <h2>Conduit could not upgrade your local data</h2>
        <p className="onboarding-lede">
          A database migration failed at startup. To keep the app usable, Conduit started
          with a fresh local store. Your previous data was backed up before the reset —
          it is untouched and you can recover from it manually.
        </p>
        <div className="status-item onboarding-status">
          <span className="onboarding-meta-label">Backup path</span>
          <span className="onboarding-mono">{recovery.backupPath}</span>
          <span className="onboarding-meta-label">Error</span>
          <span className="onboarding-mono">{recovery.error}</span>
        </div>
        <p className="onboarding-hint">
          You can continue right now with the fresh store — everything works, it is just
          empty. Restarting re-runs the upgrade from scratch, which is worth one try if the
          failure was transient. If you would rather not keep the backup, delete it below.
        </p>

        <div className="actions onboarding-actions">
          <button
            className="btn primary"
            type="button"
            disabled={busy !== null}
            onClick={() => void handleContinue()}
          >
            {busy === 'continue' ? 'Continuing…' : 'Continue with the fresh store'}
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy !== null}
            onClick={() => void handleRestart()}
          >
            {busy === 'restart' ? 'Restarting…' : 'Restart Conduit'}
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy !== null}
            aria-expanded={showDelete}
            aria-controls="recovery-delete-panel"
            onClick={() => setShowDelete((v) => !v)}
          >
            Delete data…
          </button>
        </div>

        {showDelete && (
          <section
            className="recovery-danger"
            id="recovery-delete-panel"
            aria-label="Delete local data"
          >
            <h3 className="onboarding-step-title">Delete local data</h3>

            <div className="recovery-danger-row">
              <div className="srow-text">
                <b>Delete the backup only</b>
                <small>
                  Removes the{' '}
                  {recovery.backupExists ? formatBytes(recovery.backupBytes) : 'saved'} backup of
                  the store that failed to upgrade. Your fresh store and settings are not
                  touched, and no restart is needed.
                </small>
              </div>
              <button
                className="btn danger"
                type="button"
                disabled={busy !== null || !recovery.backupExists}
                onClick={() => void handleDiscardBackup()}
              >
                {busy === 'discard' ? 'Deleting…' : 'Delete backup'}
              </button>
            </div>

            <div className="recovery-danger-row recovery-danger-row--stack">
              <div className="srow-text">
                <b>Delete local data and start over</b>
                <small>
                  Applied on the next launch — the database is held open while Conduit is
                  running, so the delete happens at startup. Conduit restarts immediately.
                </small>
              </div>
              <fieldset className="recovery-scope">
                <legend className="onboarding-meta-label">How much to delete</legend>
                <label className="onboarding-check">
                  <input
                    type="radio"
                    name="wipe-scope"
                    value="conversations"
                    checked={scope === 'conversations'}
                    onChange={() => setScope('conversations')}
                  />
                  Conversations, attachments, artifacts, and backups. Your settings and API
                  keys are kept.
                </label>
                <label className="onboarding-check">
                  <input
                    type="radio"
                    name="wipe-scope"
                    value="everything"
                    checked={scope === 'everything'}
                    onChange={() => setScope('everything')}
                  />
                  Everything above plus settings, logs, and diagnostics — back to a first
                  run. API keys stay in your OS keychain either way.
                </label>
              </fieldset>
              <label className="onboarding-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I understand this cannot be undone.
              </label>
              <button
                className="btn danger"
                type="button"
                disabled={busy !== null || !confirmed}
                onClick={() => void handleWipe()}
              >
                {busy === 'wipe' ? 'Restarting…' : 'Delete and restart'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** Byte counts here exist to justify a delete, so one decimal is enough —
 *  more digits imply a precision the user has no way to check. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
