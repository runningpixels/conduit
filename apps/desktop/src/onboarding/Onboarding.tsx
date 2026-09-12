import { useEffect, useState } from 'react';
import type {
  AppSettings,
  MigrationRecoveryInfo,
  ProviderDescriptor,
  WipeScope,
} from '../ipc/contracts';
import type { StatusState } from '../chat/statusTypes';
import {
  acknowledgeMigrationRecovery,
  discardMigrationBackup,
  getOnboardingState,
  listProviderDescriptors,
  requestLocalDataWipe,
  restartApp,
  updateSettings,
} from '../ipc/client';
import { ProviderPicker } from '../workspace/settings/ProviderPicker';
import { ConnectorsSection } from '../workspace/settings/ConnectorsSection';
import { localeEntry, useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { useAutoSave } from '../workspace/settings/useAutoSave';
import { AppearanceStep } from './AppearanceStep';
import { PrivacyStep } from './PrivacyStep';

type OnboardingStep = 'appearance' | 'provider' | 'privacy' | 'connectors' | 'finish';

const STEPS: { id: OnboardingStep; labelId: string }[] = [
  { id: 'appearance', labelId: 'onboarding.steps.appearance' },
  { id: 'provider', labelId: 'onboarding.steps.provider' },
  { id: 'privacy', labelId: 'onboarding.steps.privacy' },
  { id: 'connectors', labelId: 'onboarding.steps.connectors' },
  { id: 'finish', labelId: 'onboarding.steps.finish' },
];

/** Phase 6 M6.4: first-run onboarding — the BYOK gate. Full-screen route (not a
 *  modal) shown by `App.tsx` while `onboardingCompleted` is false or no provider
 *  credential is configured. Reuses the shared `ProviderPicker` (provider + BYOK
 *  entry via the OS keychain) and `ConnectorsSection` so it does not duplicate
 *  the Settings screen flows.
 *
 *  Steps: appearance → provider/BYOK → privacy & updates → optional connectors
 *  → review → "Get started". The hard gate is still a configured provider —
 *  chat is useless without one — and every other step is skippable.
 *
 *  **Appearance leads, and that ordering is load-bearing rather than
 *  aesthetic.** Switching language re-mounts `<App>` (`I18nProvider` carries
 *  `key={locale}`), which resets this component's `step` and empties every
 *  uncommitted field below it. On step one there is nothing yet to lose; two
 *  steps later it would discard a half-typed API key. `persistSteps.ts` carries
 *  the rest of that story, including why the language write is awaited while
 *  every other setting is optimistic. */
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
  const [step, setStep] = useState<OnboardingStep>('appearance');
  const stepIndex = STEPS.findIndex((s) => s.id === step);
  /* Only so the review step can name the provider the way the picker labelled
     it. A failed lookup falls back to the raw id rather than blocking the
     step — the gate that matters is the keychain probe in `handleFinish`. */
  const [providers, setProviders] = useState<ProviderDescriptor[]>([]);
  const saveProviderStep = useAutoSave(onSettingsChange, onStatus);

  useEffect(() => {
    if (step !== 'finish') return;
    void (async () => {
      try {
        setProviders(await listProviderDescriptors());
      } catch {
        setProviders([]);
      }
    })();
  }, [step]);

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
    <div className="onboarding-shell">
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

        {step === 'appearance' && (
          <AppearanceStep settings={settings} onSettingsChange={onSettingsChange} onStatus={onStatus} />
        )}

        {step === 'provider' && (
          <section className="onboarding-step-body" aria-label={t('onboarding.provider.ariaLabel')}>
            <h3 className="onboarding-step-title">{t('onboarding.provider.stepTitle')}</h3>
            {/* Debounced rather than the steps' un-debounced writer: this is the
                one step with free-text fields (model id, base URL), and a write
                per keystroke is not what those want. `useAutoSave` is what the
                Settings pane gives the same component.

                It has to persist at all, though, and originally did not — the
                provider step handed App's raw setter straight through, so
                nothing reached disk until "Get started". That quietly undid the
                local-only fix: picking a cloud provider cleared the flag in
                memory, the checkbox on the privacy step agreed, and quitting
                before the end left `local_only: true` on disk next to a cloud
                provider — the exact trap the fix exists to close, now with the
                UI having already told the user it was handled. */}
            <ProviderPicker settings={settings} onSettingsChange={saveProviderStep} onStatus={onStatus} />
            <p className="onboarding-hint">{t('onboarding.provider.hint')}</p>
          </section>
        )}

        {step === 'privacy' && (
          <PrivacyStep settings={settings} onSettingsChange={onSettingsChange} onStatus={onStatus} />
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
            <p className="onboarding-lede">{t('onboarding.finish.summaryLede')}</p>
            {/* A review rather than another form. Four steps of choices are more
                than anyone holds in their head, and the one that silently
                breaks chat — a cloud provider under local-only mode — is worth
                showing back before the gate closes. Values are data (a brand
                name, a model id, a language in its own language), so they are
                rendered through expressions rather than the catalog. */}
            <dl className="onboarding-summary">
              <dt>{t('settings.provider.providerLabel')}</dt>
              <dd>
                {providers.find((p) => p.id === settings.activeProvider)?.displayName ??
                  settings.activeProvider}
              </dd>
              <dt>{t('settings.provider.modelLabel')}</dt>
              <dd>{settings.activeModel}</dd>
              <dt>{t('settings.appearance.language.label')}</dt>
              <dd>
                {settings.language === 'system'
                  ? t('settings.appearance.language.system')
                  : (localeEntry(settings.language)?.nativeName ?? settings.language)}
              </dd>
              <dt>{t('settings.appearance.theme.label')}</dt>
              <dd>
                {settings.theme === 'dark'
                  ? t('settings.appearance.theme.optionDark')
                  : settings.theme === 'light'
                    ? t('settings.appearance.theme.optionLight')
                    : t('settings.appearance.theme.optionSystem')}
              </dd>
              <dt>{t('settings.privacy.localOnlyToggle.label')}</dt>
              <dd>
                {settings.localOnly
                  ? t('onboarding.finish.summaryOn')
                  : t('onboarding.finish.summaryOff')}
              </dd>
            </dl>
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
  const fmt = useFormatters();
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
              freed: fmt.size(report.freedBytes),
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
    <div className="onboarding-shell">
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
                    ? t('recovery.delete.backupOnly.body', { backupSize: fmt.size(recovery.backupBytes) })
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
