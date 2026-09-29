import { useId, useState } from 'react';
import type { AccentOverride } from '../../ipc/contracts';
import { useT } from '../../i18n';
import { ACCENT_SWATCHES, DEFAULT_ACCENT, deriveAccent, type AccentMode } from '../../themes/accent';

interface AccentPickerProps {
  value: AccentOverride | undefined;
  onChange: (next: AccentOverride) => void;
}

const MODES: readonly { mode: AccentMode; labelKey: string }[] = [
  { mode: 'dark', labelKey: 'settings.appearance.accent.darkRow' },
  { mode: 'light', labelKey: 'settings.appearance.accent.lightRow' },
];

/**
 * The main colour (ADR-011): one accent per mode, from a curated set of
 * swatches or a custom colour. A custom colour that would not be legible
 * (`deriveAccent`) is refused with a message and not saved, so the setting
 * can never hold a colour the app would then silently ignore.
 */
export function AccentPicker({ value, onChange }: AccentPickerProps) {
  const t = useT();
  const labelId = useId();
  const hintId = useId();
  const [error, setError] = useState<Partial<Record<AccentMode, boolean>>>({});

  function choose(mode: AccentMode, hex: string): void {
    const verdict = deriveAccent(hex, mode);
    if (!verdict.ok) {
      setError((e) => ({ ...e, [mode]: true }));
      return;
    }
    setError((e) => ({ ...e, [mode]: false }));
    // The default is stored as "no override", so a later change to the
    // design's default reaches people who never picked a colour.
    const next = verdict.family.accent === DEFAULT_ACCENT[mode] ? undefined : verdict.family.accent;
    onChange({ dark: value?.dark ?? undefined, light: value?.light ?? undefined, [mode]: next });
  }

  return (
    <div className="accent-picker" role="group" aria-labelledby={labelId} aria-describedby={hintId}>
      <span className="field-label" id={labelId}>
        {t('settings.appearance.accent.label')}
      </span>
      <small id={hintId}>{t('settings.appearance.accent.hint')}</small>
      {MODES.map(({ mode, labelKey }) => {
        const current = value?.[mode] ?? DEFAULT_ACCENT[mode];
        const swatches = ACCENT_SWATCHES[mode];
        const isCustom = !swatches.includes(current);
        const rowLabelId = `${labelId}-${mode}`;
        const errorId = `${labelId}-${mode}-error`;
        return (
          <div className="accent-row" key={mode}>
            <span className="accent-row-label" id={rowLabelId}>
              {t(labelKey)}
            </span>
            <div
              className="accent-swatches"
              role="radiogroup"
              aria-labelledby={rowLabelId}
              aria-describedby={error[mode] ? errorId : undefined}
            >
              {swatches.map((hex, index) => {
                const checked = hex === current;
                return (
                  <button
                    key={hex}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    aria-label={index === 0 ? t('settings.appearance.accent.default') : t('settings.appearance.accent.swatch', { hex })}
                    title={hex}
                    className={`accent-swatch${checked ? ' accent-swatch--selected' : ''}`}
                    style={{ background: hex }}
                    onClick={() => choose(mode, hex)}
                  />
                );
              })}
              <label className={`accent-custom${isCustom ? ' accent-custom--selected' : ''}`}>
                <input
                  type="color"
                  value={current}
                  onChange={(e) => choose(mode, e.target.value)}
                />
                <span>{t('settings.appearance.accent.custom')}</span>
              </label>
            </div>
            {error[mode] && (
              <p className="accent-error" id={errorId} role="status">
                {t('settings.appearance.accent.lowContrast')}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
