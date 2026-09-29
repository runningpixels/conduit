import { useId, useRef, type KeyboardEvent } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { useT } from '../../i18n';

type Mode = AppSettings['theme'];

interface ModePickerProps {
  value: Mode;
  onChange: (next: Mode) => void;
  /** `onboarding` renders a tighter card grid for the narrower wizard column. */
  variant?: 'settings' | 'onboarding';
}

/** [ground, surface, ink, accent] per mode — ADR-011's token values, so the
 *  preview shows what the mode will actually look like. */
const SWATCHES: Record<Exclude<Mode, 'system'>, readonly [string, string, string, string]> = {
  dark: ['#0b0d12', '#11141b', '#e8eaf0', '#ff7a59'],
  light: ['#f6f6f8', '#ffffff', '#16181d', '#4b4ded'],
};

const OPTIONS: readonly { mode: Mode; labelKey: string }[] = [
  { mode: 'dark', labelKey: 'settings.appearance.theme.optionDark' },
  { mode: 'light', labelKey: 'settings.appearance.theme.optionLight' },
  { mode: 'system', labelKey: 'settings.appearance.theme.optionSystem' },
];

/**
 * The appearance mode picker (ADR-011: one design, two modes). A `radiogroup`
 * of three cards — Dark, Light, and System (follow the OS) — writing
 * `AppSettings.theme`. It replaces the look × palette theme picker.
 *
 * Arrow keys move the selection and focus together (one roving tabstop), as a
 * native radio group does.
 */
export function ModePicker({ value, onChange, variant = 'settings' }: ModePickerProps) {
  const t = useT();
  const labelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const checkedIndex = Math.max(
    0,
    OPTIONS.findIndex((o) => o.mode === value),
  );

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % OPTIONS.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + OPTIONS.length) % OPTIONS.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = OPTIONS.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    onChange(OPTIONS[next].mode);
    rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div className={`theme-picker theme-picker--${variant}`} ref={rootRef}>
      <span className="field-label" id={labelId}>
        {t('settings.appearance.theme.label')}
      </span>
      <div className="theme-picker-grid" role="radiogroup" aria-labelledby={labelId}>
        {OPTIONS.map((option, index) => {
          const checked = index === checkedIndex;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              className={`theme-card${checked ? ' theme-card--selected' : ''}`}
              onClick={() => onChange(option.mode)}
              onKeyDown={(e) => handleKeyDown(e, index)}
            >
              {option.mode === 'system' ? (
                <span className="theme-card-preview theme-card-preview--split" aria-hidden="true">
                  <Preview swatches={SWATCHES.light} />
                  <Preview swatches={SWATCHES.dark} />
                </span>
              ) : (
                <span className="theme-card-preview" aria-hidden="true">
                  <Preview swatches={SWATCHES[option.mode]} />
                </span>
              )}
              <span className="theme-card-name">{t(option.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Preview({ swatches }: { swatches: readonly [string, string, string, string] }) {
  const [ground, surface, ink, accent] = swatches;
  return (
    <span className="theme-card-preview-ground" style={{ background: ground }}>
      <span className="theme-card-preview-surface" style={{ background: surface }}>
        <span className="theme-card-preview-ink" style={{ background: ink }} />
        <span className="theme-card-preview-accent" style={{ background: accent }} />
      </span>
    </span>
  );
}
