import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { CUSTOM_THEME_ID, THEMES } from '../../themes/registry';
import { readThemeId, selectTheme, THEME_CHANGED_EVENT } from '../../shell/uiPrefs';
import { useT } from '../../i18n';

interface ThemePickerProps {
  /** `onboarding` renders a tighter card grid for the narrower wizard column. */
  variant?: 'settings' | 'onboarding';
}

/**
 * The user-facing theme picker (theming Phase 2): a `radiogroup` of cards, one
 * per manifest in `themes/registry.ts`. Selecting a card writes both the
 * `look` and `palette` axes at once via `selectTheme` (`shell/uiPrefs.ts`).
 *
 * The current theme is *derived*, never held as this component's own source
 * of truth (`readThemeId`), so it cannot drift from the two prefs it
 * describes — and it stays in sync with the Advanced look/palette selects,
 * which can also change it, via `THEME_CHANGED_EVENT`.
 *
 * Keyboard model follows the WAI-ARIA radiogroup pattern: one roving
 * tabstop (the checked card, or the first card when none is — the `custom`
 * state), and Left/Up/Right/Down/Home/End both move focus and select.
 */
export function ThemePicker({ variant = 'settings' }: ThemePickerProps) {
  const t = useT();
  const labelId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const [themeId, setThemeId] = useState(() => readThemeId());

  useEffect(() => {
    const onChange = () => setThemeId(readThemeId());
    window.addEventListener(THEME_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onChange);
  }, []);

  const isCustom = themeId === CUSTOM_THEME_ID;
  const checkedIndex = THEMES.findIndex((theme) => theme.id === themeId);
  // No card is checked in the `custom` state (an Advanced look x palette pairing
  // no manifest names); the first card still needs to be the one Tab reaches.
  const activeIndex = checkedIndex === -1 ? 0 : checkedIndex;

  function focusCard(index: number): void {
    const cards = groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    cards?.[index]?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % THEMES.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + THEMES.length) % THEMES.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = THEMES.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectTheme(THEMES[next].id);
    focusCard(next);
  }

  return (
    <div className={`theme-picker theme-picker--${variant}`}>
      <span className="field-label" id={labelId}>
        {t('settings.appearance.themes.label')}
      </span>
      <div className="theme-picker-grid" role="radiogroup" aria-labelledby={labelId} ref={groupRef}>
        {THEMES.map((theme, index) => {
          const checked = theme.id === themeId;
          const [ground, surface, ink, accent] = theme.swatches;
          const singleModeLabel =
            theme.modes.length === 1
              ? t(theme.modes[0] === 'dark' ? 'settings.appearance.themes.darkOnlyLabel' : 'settings.appearance.themes.lightOnlyLabel')
              : null;
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={index === activeIndex ? 0 : -1}
              className={`theme-card${checked ? ' theme-card--selected' : ''}`}
              onClick={() => selectTheme(theme.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
            >
              <span className="theme-card-preview" aria-hidden="true" style={{ background: ground }}>
                <span className="theme-card-preview-surface" style={{ background: surface }}>
                  <span className="theme-card-preview-ink" style={{ background: ink }} />
                  <span className="theme-card-preview-accent" style={{ background: accent }} />
                </span>
              </span>
              <span className="theme-card-body">
                <span className="theme-card-name">
                  {t(`settings.appearance.themes.${theme.i18nKey}.name`)}
                  {singleModeLabel && <span className="theme-card-badge">{singleModeLabel}</span>}
                </span>
                <span className="theme-card-description">
                  {t(`settings.appearance.themes.${theme.i18nKey}.description`)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {isCustom && <p className="theme-picker-note">{t('settings.appearance.themes.customNote')}</p>}
    </div>
  );
}
