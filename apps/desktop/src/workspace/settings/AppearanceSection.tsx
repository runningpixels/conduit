import { useEffect, useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import {
  applyRailStyle,
  applyUiReadability,
  readRailStyle,
  readUiDensity,
  type RailStyle,
  readUiFontSize,
  type UiDensity,
  type UiFontSize,
} from '../readability';
import { readMermaidScale, writeMermaidScale, type MermaidScalePref } from '../../shell/uiPrefs';
import { SHIPPED_LOCALES, TRANSLATED_LOCALE_CODES, useT } from '../../i18n';
import { ModePicker } from './ModePicker';

interface AppearanceSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
}

/** Appearance settings: language, mode, readability, diagram size, and artifact styled preview. */
export function AppearanceSection({ settings, onUpdate }: AppearanceSectionProps) {
  const t = useT();
  const [fontSize, setFontSize] = useState<UiFontSize>(() => readUiFontSize());
  const [density, setDensity] = useState<UiDensity>(() => readUiDensity());
  const [railStyle, setRailStyle] = useState<RailStyle>(() => readRailStyle());
  const [mermaidScale, setMermaidScale] = useState<MermaidScalePref>(() => readMermaidScale());

  useEffect(() => {
    applyUiReadability(fontSize, density);
  }, [fontSize, density]);

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
        {/* ADR-011: one design in two modes; the mode is AppSettings.theme. */}
        <ModePicker value={settings.theme} onChange={(theme) => onUpdate({ ...settings, theme })} />
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
          <span className="field-label">{t('settings.appearance.rail.label')}</span>
          <select
            value={railStyle}
            onChange={(e) => {
              const next = e.target.value as RailStyle;
              setRailStyle(next);
              applyRailStyle(next);
            }}
          >
            <option value="icons">{t('settings.appearance.rail.optionIcons')}</option>
            <option value="labels">{t('settings.appearance.rail.optionLabels')}</option>
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
