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
import { useT } from '../i18n';

type OnboardingStep = 'provider' | 'connectors' | 'finish';

const STEPS: { id: OnboardingStep; labelId: string }[] = [
  { id: 'provider', labelId: 'onboarding.steps.provider' },
  { id: 'connectors', labelId: 'onboarding.steps.connectors' },
  { id: 'finish', labelId: 'onboarding.steps.finish' },
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
  const t = useT();
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
        onStatus(t('onboarding.finish.needCredential'));
        setStep('provider');
        return;
      }
      const next = await updateSettings({ ...settings, onboardingCompleted: true });
      onSettingsChange(next);
      onStatus(t('onboarding.finish.welcomeStatus'));
      onComplete();
    } catch (e) {
      onStatus(t('onboarding.finish.error', { error: String(e) }));
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
        <h2>{t('onboarding.welcome.title')}</h2>
        <p className="onboarding-lede">{t('onboarding.welcome.lede')}</p>

        <nav className="onboarding-steps" aria-label={t('onboarding.nav.ariaLabel')}>
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
                {t('onboarding.steps.dotLabel', { index: i + 1, label: t(s.labelId) })}
              </button>
            );
          })}
        </nav>

        {step === 'provider' && (
          <section className="onboarding-step-body" aria-label={t('onboarding.provider.ariaLabel')}>
            <h3 className="onboarding-step-title">{t('onboarding.provider.stepTitle')}</h3>
            <ProviderPicker settings={settings} onSettingsChange={onSettingsChange} onStatus={onStatus} />
            <p className="onboarding-hint">{t('onboarding.provider.hint')}</p>
          </section>
        )}

        {step === 'connectors' && (
          <section className="onboarding-step-body" aria-label={t('onboarding.connectors.ariaLabel')}>
            <h3 className="onboarding-step-title">{t('onboarding.connectors.stepTitle')}</h3>
            <p className="onboarding-hint">{t('onboarding.connectors.hint')}</p>
            <ConnectorsSection onStatus={onStatus} />
          </section>
        )}

        {step === 'finish' && (
          <section className="onboarding-step-body" aria-label={t('onboarding.finish.ariaLabel')}>
            <h3 className="onboarding-step-title">{t('onboarding.finish.stepTitle')}</h3>
            <label className="onboarding-check">
              <input
                type="checkbox"
                checked={settings.diagnosticsEnabled}
                onChange={(e) => onSettingsChange({ ...settings, diagnosticsEnabled: e.target.checked })}
              />
              {t('onboarding.finish.diagnosticsCheckbox')}
            </label>
            <p className="onboarding-hint">{t('onboarding.finish.diagnosticsHint')}</p>
          </section>
        )}

        <div className="actions onboarding-actions">
          {stepIndex > 0 && (
            <button className="btn ghost" type="button" onClick={goBack}>
              {t('onboarding.actions.back')}
            </button>
          )}
          {step !== 'finish' ? (
            <button className="btn primary" type="button" onClick={goNext}>
              {t('onboarding.actions.continue')}
            </button>
          ) : (
            <button className="btn primary" type="button" disabled={finishing} onClick={() => void handleFinish()}>
              {finishing ? t('onboarding.actions.starting') : t('onboarding.actions.getStarted')}
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
  const t = useT();
  const [busy, setBusy] = useState<null | 'continue' | 'restart' | 'discard' | 'wipe'>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [scope, setScope] = useState<WipeScope>('conversations');
  const [confirmed, setConfirmed] = useState(false);

  async function run(kind: NonNullable<typeof busy>, action: () => Promise<void>) {
    setBusy(kind);
    try {
      await action();
    } catch (e) {
      onStatus(t('recovery.error.generic', { error: String(e) }));
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
          ? t('recovery.discardBackup.deleted', {
              count: report.removedPaths.length,
              freed: formatBytes(report.freedBytes),
            })
          : t('recovery.discardBackup.none'),
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
        <h2>{t('recovery.header.title')}</h2>
        <p className="onboarding-lede">{t('recovery.header.lede')}</p>
        <div className="status-item onboarding-status">
          <span className="onboarding-meta-label">{t('recovery.status.backupPathLabel')}</span>
          <span className="onboarding-mono">{recovery.backupPath}</span>
          <span className="onboarding-meta-label">{t('recovery.status.errorLabel')}</span>
          <span className="onboarding-mono">{recovery.error}</span>
        </div>
        <p className="onboarding-hint">{t('recovery.header.hint')}</p>

        <div className="actions onboarding-actions">
          <button
            className="btn primary"
            type="button"
            disabled={busy !== null}
            onClick={() => void handleContinue()}
          >
            {busy === 'continue' ? t('recovery.actions.continuing') : t('recovery.actions.continueFresh')}
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy !== null}
            onClick={() => void handleRestart()}
          >
            {busy === 'restart' ? t('recovery.actions.restarting') : t('recovery.actions.restart')}
          </button>
          <button
            className="btn"
            type="button"
            disabled={busy !== null}
            aria-expanded={showDelete}
            aria-controls="recovery-delete-panel"
            onClick={() => setShowDelete((v) => !v)}
          >
            {t('recovery.actions.deleteDataToggle')}
          </button>
        </div>

        {showDelete && (
          <section
            className="recovery-danger"
            id="recovery-delete-panel"
            aria-label={t('recovery.delete.panel.ariaLabel')}
          >
            <h3 className="onboarding-step-title">{t('recovery.delete.panel.title')}</h3>

            <div className="recovery-danger-row">
              <div className="srow-text">
                <b>{t('recovery.delete.backupOnly.title')}</b>
                <small>
                  {recovery.backupExists
                    ? t('recovery.delete.backupOnly.body', { backupSize: formatBytes(recovery.backupBytes) })
                    : t('recovery.delete.backupOnly.bodyUnknownSize')}
                </small>
              </div>
              <button
                className="btn danger"
                type="button"
                disabled={busy !== null || !recovery.backupExists}
                onClick={() => void handleDiscardBackup()}
              >
                {busy === 'discard'
                  ? t('recovery.delete.backupOnly.deleting')
                  : t('recovery.delete.backupOnly.deleteButton')}
              </button>
            </div>

            <div className="recovery-danger-row recovery-danger-row--stack">
              <div className="srow-text">
                <b>{t('recovery.delete.wipe.title')}</b>
                <small>{t('recovery.delete.wipe.body')}</small>
              </div>
              <fieldset className="recovery-scope">
                <legend className="onboarding-meta-label">{t('recovery.delete.wipe.scopeLegend')}</legend>
                <label className="onboarding-check">
                  <input
                    type="radio"
                    name="wipe-scope"
                    value="conversations"
                    checked={scope === 'conversations'}
                    onChange={() => setScope('conversations')}
                  />
                  {t('recovery.delete.wipe.scopeConversationsLabel')}
                </label>
                <label className="onboarding-check">
                  <input
                    type="radio"
                    name="wipe-scope"
                    value="everything"
                    checked={scope === 'everything'}
                    onChange={() => setScope('everything')}
                  />
                  {t('recovery.delete.wipe.scopeEverythingLabel')}
                </label>
              </fieldset>
              <label className="onboarding-check">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                {t('recovery.delete.wipe.confirmLabel')}
              </label>
              <button
                className="btn danger"
                type="button"
                disabled={busy !== null || !confirmed}
                onClick={() => void handleWipe()}
              >
                {busy === 'wipe'
                  ? t('recovery.delete.wipe.restarting')
                  : t('recovery.delete.wipe.deleteButton')}
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
