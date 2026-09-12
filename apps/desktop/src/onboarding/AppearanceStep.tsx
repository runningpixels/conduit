import { useEffect, useState } from 'react';
import type { AppSettings } from '../ipc/contracts';
import { SHIPPED_LOCALES, TRANSLATED_LOCALE_CODES, useT } from '../i18n';
import { applyUiReadability, readUiDensity, readUiFontSize, type UiFontSize } from '../workspace/readability';
import { readPalette, writePalette, type PalettePref } from '../shell/uiPrefs';
import { usePersistSteps } from './persistSteps';

/**
 * First-run appearance: language, theme, palette, text size.
 *
 * **Why this is step one.** Two reasons, and they point the same way. A user
 * who cannot read the interface cannot act on any later step, so the language
 * picker has to precede the prose that explains the trust model rather than
 * sit behind it. And switching language re-mounts `<App>` (see
 * `persistSteps.ts`), which resets the step position and empties any field the
 * user has typed into — free on the first step, and destructive on the step
 * where the API key goes.
 *
 * **Why these four and not the six in Settings.** Density and diagram scale are
 * refinements, and first run should only ask what someone can answer before
 * they have seen the app. "Can you read this" and "is it the right colour" are
 * answerable on sight; "comfortable or compact line spacing" is not.
 *
 * The labels are reused from `settings.appearance.*` rather than duplicated
 * under `onboarding.*`. They name the same controls, and G12 checks that prose
 * naming a UI element matches that element's label — two spellings of "Theme"
 * across eight languages is exactly the drift that guard exists to catch.
 */
export function AppearanceStep({
  settings,
  onSettingsChange,
  onStatus,
}: {
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const { set, writeThenApply } = usePersistSteps(settings, onSettingsChange, onStatus);
  const [fontSize, setFontSize] = useState<UiFontSize>(() => readUiFontSize());
  const [palette, setPalette] = useState<PalettePref>(() => readPalette());
  /* The language write is awaited, so the select has a real in-flight window.
     Disabling it stops a second choice from queueing a second re-mount. */
  const [switchingLanguage, setSwitchingLanguage] = useState(false);

  /* Density is not offered here, but `applyUiReadability` takes both, so the
     stored value is read and passed straight back through unchanged. */
  useEffect(() => {
    applyUiReadability(fontSize, readUiDensity());
  }, [fontSize]);

  async function handleLanguageChange(next: string) {
    setSwitchingLanguage(true);
    try {
      await writeThenApply({ ...settings, language: next as AppSettings['language'] });
    } finally {
      setSwitchingLanguage(false);
    }
  }

  return (
    <section className="onboarding-step-body" aria-label={t('onboarding.appearance.ariaLabel')}>
      <h3 className="onboarding-step-title">{t('onboarding.appearance.stepTitle')}</h3>
      <div className="form-grid appearance-form">
        {/* A `div` + `htmlFor` rather than a wrapping `<label>`, because this is
            the one field with a hint: inside a wrapping label the hint joins the
            select's accessible name and a screen reader announces the whole
            sentence as the field's name. Same treatment as AppearanceSection. */}
        <div className="field">
          <label className="field-label" htmlFor="onboarding-language">
            {t('settings.appearance.language.label')}
          </label>
          <select
            id="onboarding-language"
            aria-describedby="onboarding-language-hint"
            disabled={switchingLanguage}
            value={settings.language}
            onChange={(e) => void handleLanguageChange(e.target.value)}
          >
            <option value="system">{t('settings.appearance.language.system')}</option>
            {/* Only locales with a catalog actually on disk. Offering 日本語,
                accepting the click and then rendering English is not a fallback
                a user can interpret — the setting saves and nothing changes. */}
            {SHIPPED_LOCALES.filter(
              (locale) =>
                TRANSLATED_LOCALE_CODES.includes(locale.code) || locale.code === settings.language,
            ).map((locale) => (
              <option key={locale.code} value={locale.code}>
                {locale.nativeName}
              </option>
            ))}
          </select>
          <small id="onboarding-language-hint">
            {switchingLanguage
              ? t('onboarding.appearance.languageSwitching')
              : t('settings.appearance.language.hint')}
          </small>
        </div>

        <label className="field">
          <span className="field-label">{t('settings.appearance.theme.label')}</span>
          <select
            value={settings.theme}
            onChange={(e) => set('theme', e.target.value as AppSettings['theme'])}
          >
            <option value="system">{t('settings.appearance.theme.optionSystem')}</option>
            <option value="dark">{t('settings.appearance.theme.optionDark')}</option>
            <option value="light">{t('settings.appearance.theme.optionLight')}</option>
          </select>
        </label>

        {/* Palette and text size are renderer-only presentation prefs: they live
            in localStorage and on <html>, deliberately outside AppSettings, so
            they are written directly rather than through the settings path. */}
        <label className="field">
          <span className="field-label">{t('settings.appearance.palette.label')}</span>
          <select
            value={palette}
            onChange={(e) => {
              const next = e.target.value as PalettePref;
              setPalette(next);
              writePalette(next);
            }}
          >
            <option value="orange-charcoal">{t('settings.appearance.palette.optionOrangeCharcoal')}</option>
            <option value="orange-dark">{t('settings.appearance.palette.optionOrangeDark')}</option>
            <option value="terra">{t('settings.appearance.palette.optionTerra')}</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">{t('settings.appearance.fontSize.label')}</span>
          <select value={fontSize} onChange={(e) => setFontSize(e.target.value as UiFontSize)}>
            <option value="compact">{t('settings.appearance.fontSize.optionCompact')}</option>
            <option value="default">{t('settings.appearance.fontSize.optionDefault')}</option>
            <option value="comfortable">{t('settings.appearance.fontSize.optionComfortable')}</option>
          </select>
        </label>
      </div>
      <p className="onboarding-hint">{t('onboarding.appearance.hint')}</p>
    </section>
  );
}
