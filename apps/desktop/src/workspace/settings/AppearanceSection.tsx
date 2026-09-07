import { useEffect, useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import {
  applyUiReadability,
  readUiDensity,
  readUiFontSize,
  type UiDensity,
  type UiFontSize,
} from '../readability';
import { readPalette, writePalette, type PalettePref, readMermaidScale, writeMermaidScale, type MermaidScalePref } from '../../shell/uiPrefs';
import { SHIPPED_LOCALES, useT } from '../../i18n';

interface AppearanceSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
}

/** Appearance settings: palette, theme, readability, diagram size, and artifact styled preview. */
export function AppearanceSection({ settings, onUpdate }: AppearanceSectionProps) {
  const t = useT();
  const [fontSize, setFontSize] = useState<UiFontSize>(() => readUiFontSize());
  const [density, setDensity] = useState<UiDensity>(() => readUiDensity());
  const [palette, setPalette] = useState<PalettePref>(() => readPalette());
  const [mermaidScale, setMermaidScale] = useState<MermaidScalePref>(() => readMermaidScale());

  useEffect(() => {
    applyUiReadability(fontSize, density);
  }, [fontSize, density]);

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Appearance</span>
      </div>
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
            {SHIPPED_LOCALES.map((locale) => (
              <option key={locale.code} value={locale.code}>
                {locale.nativeName}
              </option>
            ))}
          </select>
          {/* D12: one setting drives both. Users would otherwise have no way to
              discover that the reply language moved with the interface. */}
          <small id="language-hint">{t('settings.appearance.language.hint')}</small>
        </div>
        {/* Palette comes before Theme: it is the coarser choice, and Theme reads
            as "light or dark *of the palette above*". Both run in both modes. */}
        <label className="field">
          <span className="field-label">Palette</span>
          <select
            value={palette}
            onChange={(e) => {
              const next = e.target.value as PalettePref;
              setPalette(next);
              writePalette(next);
            }}
          >
            <option value="orange-charcoal">Orange Charcoal — dark charcoal, terracotta</option>
            <option value="orange-dark">Orange-Dark — Claude charcoal, terracotta</option>
            <option value="terra">Terra — warm charcoal, provider colour</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Theme</span>
          <select
            value={settings.theme}
            onChange={(e) => onUpdate({ ...settings, theme: e.target.value as AppSettings['theme'] })}
          >
            <option value="system">System</option>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">UI font size</span>
          <select
            value={fontSize}
            onChange={(e) => setFontSize(e.target.value as UiFontSize)}
          >
            <option value="compact">Compact (13)</option>
            <option value="default">Default (14)</option>
            <option value="comfortable">Comfortable (15.5)</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Density</span>
          <select
            value={density}
            onChange={(e) => setDensity(e.target.value as UiDensity)}
          >
            <option value="default">Default</option>
            <option value="compact">Compact</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Diagram size</span>
          <select
            value={mermaidScale}
            onChange={(e) => {
              const next = e.target.value as MermaidScalePref;
              setMermaidScale(next);
              writeMermaidScale(next);
            }}
          >
            <option value="compact">Compact (75%)</option>
            <option value="default">Default (85%)</option>
            <option value="full">Full (100%)</option>
          </select>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={settings.artifactStyledPreview ?? true}
            onChange={(e) => onUpdate({ ...settings, artifactStyledPreview: e.target.checked })}
          />
          Apply app-like styling to rendered artifacts (typography, spacing, code blocks)
        </label>
      </div>
    </div>
  );
}
