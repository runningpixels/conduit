import type { AppSettings, RolloutChannel } from '../ipc/contracts';
import { useRichT, useT } from '../i18n';
import { usePersistSteps } from './persistSteps';

/**
 * First-run privacy and updates: local-only mode, where keys are stored,
 * update checks, and diagnostics.
 *
 * **Why these belong in setup rather than only in Settings.** They are the
 * settings the welcome lede has just made promises about — "there is no
 * background telemetry; update checks are opt-in" — and a promise the user
 * cannot see the switch for is a claim rather than a choice. Diagnostics moved
 * here from the finish step for the same reason: it is a privacy decision, it
 * reads as one next to the other three, and the finish step is better spent
 * showing the user what they have actually configured.
 *
 * **Local-only sits first and is the reason this step exists.** It defaults to
 * on, and while it is on Rust rejects every cloud provider at stream time. The
 * provider step clears it when a cloud provider is chosen; showing the flag
 * here is what makes that an observable change rather than a silent one.
 *
 * Copy is reused from `settings.privacy.*` and `settings.updates.*`. It states
 * the trade rather than presenting equal options — the file-backed key store is
 * an escape hatch for machines with no keychain, and it is weaker — which is
 * the register the Settings pane already set.
 */
export function PrivacyStep({
  settings,
  onSettingsChange,
  onStatus,
}: {
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const tr = useRichT();
  const { set } = usePersistSteps(settings, onSettingsChange, onStatus);

  return (
    <section className="onboarding-step-body" aria-label={t('onboarding.privacy.ariaLabel')}>
      <h3 className="onboarding-step-title">{t('onboarding.privacy.stepTitle')}</h3>

      <label className="onboarding-check">
        <input
          type="checkbox"
          checked={settings.localOnly}
          onChange={(e) => set('localOnly', e.target.checked)}
        />
        {t('settings.privacy.localOnlyToggle.label')}
      </label>
      <p className="onboarding-hint">{t('onboarding.privacy.localOnlyHint')}</p>

      <div className="field onboarding-field">
        <label className="field-label" htmlFor="onboarding-keychain-mode">
          {t('settings.privacy.keychainMode.label')}
        </label>
        <select
          id="onboarding-keychain-mode"
          aria-describedby="onboarding-keychain-hint"
          value={settings.keychainMode}
          onChange={(e) => set('keychainMode', e.target.value as AppSettings['keychainMode'])}
        >
          <option value="os">{t('settings.privacy.keychainMode.optionOs')}</option>
          <option value="file">{t('settings.privacy.keychainMode.optionFile')}</option>
        </select>
        <small id="onboarding-keychain-hint">
          {settings.keychainMode === 'file'
            ? tr('settings.privacy.keychainMode.fileBody', { envVar: 'CONDUIT_CREDENTIAL_KEY' })
            : t('settings.privacy.keychainMode.osBody')}
        </small>
      </div>

      <label className="onboarding-check">
        <input
          type="checkbox"
          checked={settings.updateCheckEnabled}
          onChange={(e) => set('updateCheckEnabled', e.target.checked)}
        />
        {t('settings.updates.checkbox.allow')}
      </label>
      {/* The channel only means anything if checks are allowed at all, so it
          follows the toggle and disables with it rather than sitting beside it
          as an equal choice. */}
      <div className="field onboarding-field">
        <label className="field-label" htmlFor="onboarding-update-channel">
          {t('settings.updates.channel.label')}
        </label>
        <select
          id="onboarding-update-channel"
          disabled={!settings.updateCheckEnabled}
          value={settings.updateChannel}
          onChange={(e) => set('updateChannel', e.target.value as RolloutChannel)}
        >
          <option value="stable">{t('settings.updates.channel.stable')}</option>
          <option value="beta">{t('settings.updates.channel.beta')}</option>
        </select>
      </div>
      <p className="onboarding-hint">{t('settings.updates.disclosure.body')}</p>

      <label className="onboarding-check">
        <input
          type="checkbox"
          checked={settings.diagnosticsEnabled}
          onChange={(e) => set('diagnosticsEnabled', e.target.checked)}
        />
        {t('onboarding.privacy.diagnosticsCheckbox')}
      </label>
      <p className="onboarding-hint">{t('onboarding.privacy.diagnosticsHint')}</p>
    </section>
  );
}
