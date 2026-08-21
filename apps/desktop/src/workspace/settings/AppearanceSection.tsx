import { useEffect, useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import {
  applyUiReadability,
  readUiDensity,
  readUiFontSize,
  type UiDensity,
  type UiFontSize,
} from '../readability';
import { readPalette, writePalette, type PalettePref } from '../../shell/uiPrefs';

interface AppearanceSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
}

/** Appearance settings: palette, theme, readability, and artifact styled preview. */
export function AppearanceSection({ settings, onUpdate }: AppearanceSectionProps) {
  const [fontSize, setFontSize] = useState<UiFontSize>(() => readUiFontSize());
  const [density, setDensity] = useState<UiDensity>(() => readUiDensity());
  const [palette, setPalette] = useState<PalettePref>(() => readPalette());

  useEffect(() => {
    applyUiReadability(fontSize, density);
  }, [fontSize, density]);

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Appearance</span>
      </div>
      <div className="form-grid appearance-form">
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
