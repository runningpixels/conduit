import { useEffect, useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import {
  applyUiReadability,
  readUiDensity,
  readUiFontSize,
  type UiDensity,
  type UiFontSize,
} from '../readability';
import {
  isBrandActive,
  readLook,
  readMermaidScale,
  readPalette,
  supportedModes,
  writeLook,
  writeMermaidScale,
  writePalette,
  THEME_CHANGED_EVENT,
  type LookPref,
  type MermaidScalePref,
  type PalettePref,
} from '../../shell/uiPrefs';
import { LOOK_IDS, type Mode } from '../../themes/registry';
import { SHIPPED_LOCALES, TRANSLATED_LOCALE_CODES, useT } from '../../i18n';
import { ThemePicker } from './ThemePicker';

interface AppearanceSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
}

/** Appearance settings: theme, readability, diagram size, and artifact styled preview. */
export function AppearanceSection({ settings, onUpdate }: AppearanceSectionProps) {
  const t = useT();
  const [fontSize, setFontSize] = useState<UiFontSize>(() => readUiFontSize());
  const [density, setDensity] = useState<UiDensity>(() => readUiDensity());
  const [look, setLook] = useState<LookPref>(() => readLook());
  const [palette, setPalette] = useState<PalettePref>(() => readPalette());
  const [modes, setModes] = useState<readonly Mode[]>(() => supportedModes());
  const [mermaidScale, setMermaidScale] = useState<MermaidScalePref>(() => readMermaidScale());
  /* Computed per render rather than held in state: SettingsSheet mounts only
   * the active section, so visiting Branding and coming back remounts this —
   * the only moment the answer can change. */
  const brandActive = isBrandActive();

  useEffect(() => {
    applyUiReadability(fontSize, density);
  }, [fontSize, density]);

  /* ThemePicker (and the Advanced look/palette selects below) can change
     which modes the active theme supports without this component
     remounting, so the Mode select's disabled state and Advanced's own
     selects have to re-read on every `THEME_CHANGED_EVENT` rather than only
     on mount. */
  useEffect(() => {
    const onThemeChanged = () => {
      setLook(readLook());
      setPalette(readPalette());
      setModes(supportedModes());
    };
    window.addEventListener(THEME_CHANGED_EVENT, onThemeChanged);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onThemeChanged);
  }, []);

  /* A dark-only theme forces dark without touching the saved `AppSettings.theme`
     (registry.ts) — so the mode select is disabled and explains why, rather
     than silently discarding whatever the user had chosen. */
  const modeForced = !modes.includes('light');

  /* No section header: SettingsSheet already renders "Appearance" as the pane
     heading, and a second copy of the same word cost a row at the top of the
     pane and read as a stutter. Connectors, Prompts and Privacy & data dropped
     theirs for the same reason. */
  return (
    <div className="settings-section">
      <div className="form-grid appearance-form">
        {/* Language leads the section. It is not a look, so it sits oddly under
            "Appearance" — but it is the first thing someone reading the UI in a
            language they do not want will go hunting for, and the top of the
            first settings pane is where they will look. The option labels are
            each written in their own language, so the list stays findable even
            when the surrounding chrome is not readable to them. */}
        {/* A `div` + `htmlFor` rather than the wrapping `<label>` the rows below
            use, because this is the one field here with a hint: inside a
            wrapping label the hint text joins the select's accessible name, so
            a screen reader would announce the whole sentence as the field's
            name. `aria-describedby` is the right relationship — it is read
            after the name, as a description. */}
        <div className="field">
          <label className="field-label" htmlFor="language-select">
            {t('settings.appearance.language.label')}
          </label>
          <select
            id="language-select"
            aria-describedby="language-hint"
            value={settings.language}
            onChange={(e) =>
              onUpdate({ ...settings, language: e.target.value as AppSettings['language'] })
            }
          >
            <option value="system">{t('settings.appearance.language.system')}</option>
            {SHIPPED_LOCALES.filter(
              (locale) =>
                TRANSLATED_LOCALE_CODES.includes(locale.code) ||
                /* Keep whatever is already saved, even with no catalog behind
                 * it: a user who picked a locale from an earlier build should
                 * see their choice in the menu rather than a blank select. */
                locale.code === settings.language,
            ).map((locale) => (
              <option key={locale.code} value={locale.code}>
                {locale.nativeName}
              </option>
            ))}
          </select>
          {/* D12: one setting drives both. Users would otherwise have no way to
              discover that the reply language moved with the interface. */}
          <small id="language-hint">{t('settings.appearance.language.hint')}</small>
        </div>
        {/* Theme (look x palette) replaces the old standalone Palette select. */}
        <ThemePicker />
        {/* A `div` + `htmlFor`, not the wrapping `<label>` the fields below use,
            for the same reason as Language: the hint would otherwise join the
            select's accessible name. Only rendered when there is a hint to
            join, so the common case keeps the plain relationship. */}
        <div className="field">
          <label className="field-label" htmlFor="mode-select">
            {t('settings.appearance.theme.label')}
          </label>
          <select
            id="mode-select"
            aria-describedby={modeForced ? 'mode-select-hint' : undefined}
            disabled={modeForced}
            value={settings.theme}
            onChange={(e) => onUpdate({ ...settings, theme: e.target.value as AppSettings['theme'] })}
          >
            <option value="system">{t('settings.appearance.theme.optionSystem')}</option>
            <option value="dark">{t('settings.appearance.theme.optionDark')}</option>
            <option value="light">{t('settings.appearance.theme.optionLight')}</option>
          </select>
          {modeForced && (
            <small id="mode-select-hint">{t('settings.appearance.theme.hintDarkOnly')}</small>
          )}
        </div>
        {/* Look and palette can be mixed independently of the named themes above
            (registry.ts) — kept behind a disclosure because most people never
            need to, and the picker above already covers the common case. */}
        <details className="appearance-advanced">
          <summary>{t('settings.appearance.advanced.summary')}</summary>
          <div className="appearance-advanced-body">
            <label className="field">
              <span className="field-label">{t('settings.appearance.look.label')}</span>
              <select
                value={look}
                onChange={(e) => {
                  const next = e.target.value as LookPref;
                  setLook(next);
                  writeLook(next);
                }}
              >
                {LOOK_IDS.map((id) => (
                  <option key={id} value={id}>
                    {t(`settings.appearance.look.options.${id}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <label className="field-label" htmlFor="advanced-palette-select">
                {t('settings.appearance.palette.label')}
              </label>
              <select
                id="advanced-palette-select"
                aria-describedby={brandActive ? 'advanced-palette-hint' : undefined}
                disabled={brandActive}
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
              {brandActive && (
                <small id="advanced-palette-hint">{t('settings.appearance.palette.hintBrand')}</small>
              )}
            </div>
          </div>
        </details>
        <label className="field">
          <span className="field-label">{t('settings.appearance.fontSize.label')}</span>
          <select
            value={fontSize}
            onChange={(e) => setFontSize(e.target.value as UiFontSize)}
          >
            <option value="compact">{t('settings.appearance.fontSize.optionCompact')}</option>
            <option value="default">{t('settings.appearance.fontSize.optionDefault')}</option>
            <option value="comfortable">{t('settings.appearance.fontSize.optionComfortable')}</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('settings.appearance.density.label')}</span>
          <select
            value={density}
            onChange={(e) => setDensity(e.target.value as UiDensity)}
          >
            <option value="default">{t('settings.appearance.density.optionDefault')}</option>
            <option value="compact">{t('settings.appearance.density.optionCompact')}</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">{t('settings.appearance.diagramSize.label')}</span>
          <select
            value={mermaidScale}
            onChange={(e) => {
              const next = e.target.value as MermaidScalePref;
              setMermaidScale(next);
              writeMermaidScale(next);
            }}
          >
            <option value="compact">{t('settings.appearance.diagramSize.optionCompact')}</option>
            <option value="default">{t('settings.appearance.diagramSize.optionDefault')}</option>
            <option value="full">{t('settings.appearance.diagramSize.optionFull')}</option>
          </select>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.artifactStyledPreview ?? true}
            onChange={(e) => onUpdate({ ...settings, artifactStyledPreview: e.target.checked })}
          />
          {t('settings.appearance.artifactStyledPreview.label')}
        </label>
      </div>
    </div>
  );
}
