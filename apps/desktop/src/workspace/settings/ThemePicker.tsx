import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CUSTOM_THEME_ID, THEMES, type ThemeManifest } from '../../themes/registry';
import { readThemeId, selectTheme, THEME_CHANGED_EVENT } from '../../shell/uiPrefs';
import {
  clearUserThemeSelection,
  isResolvedUserTheme,
  resolveUserTheme,
  selectUserTheme,
  type ResolvedUserTheme,
  type UserThemeInvalid,
} from '../../themes/userThemes';
import { createExampleUserTheme, listUserThemes, revealThemesDir } from '../../ipc/client';
import type { UserThemeEntry } from '../../ipc/contracts';
import { translateError } from '../../ipc/errors';
import { useT } from '../../i18n';

interface ThemePickerProps {
  /** `onboarding` renders a tighter card grid for the narrower wizard column. */
  variant?: 'settings' | 'onboarding';
}

/** One entry in the combined keyboard-navigable card sequence. */
type Card =
  | { kind: 'builtin'; id: string; manifest: ThemeManifest }
  | { kind: 'user'; id: string; resolved: ResolvedUserTheme };

/**
 * The user-facing theme picker (theming Phase 2, extended in Phase 5 for
 * user theme files): a `radiogroup` of cards, one per manifest in
 * `themes/registry.ts`, plus — below it — a second `radiogroup` of cards for
 * every valid user theme file (`themes/userThemes.ts`) and a plain list of
 * the invalid ones.
 *
 * Two DOM radiogroups (each with its own accessible name), but ONE roving
 * tabstop and ONE arrow-key sequence spanning both: pressing ArrowRight on
 * the last built-in card moves into the first user card. That is what
 * `cards` below exists for — the combined, keyboard-ordered list neither
 * radiogroup owns alone.
 *
 * The current theme is *derived*, never held as this component's own source
 * of truth (`readThemeId`), so it cannot drift from the prefs/cache it
 * describes — and it stays in sync with the Advanced look/palette selects,
 * which can also change it, via `THEME_CHANGED_EVENT`.
 */
export function ThemePicker({ variant = 'settings' }: ThemePickerProps) {
  const t = useT();
  const labelId = useId();
  const userLabelId = useId();
  const invalidLabelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [themeId, setThemeId] = useState(() => readThemeId());

  useEffect(() => {
    const onChange = () => setThemeId(readThemeId());
    window.addEventListener(THEME_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onChange);
  }, []);

  // `null` while the first fetch is in flight; `dev:web` (no backend) and an
  // unregistered command both reject, and both degrade to "no user themes"
  // rather than surfacing anything — only an explicit Reload click reports a
  // failure inline (see `handleReload`).
  const [entries, setEntries] = useState<UserThemeEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchEntries = useCallback(() => listUserThemes(), []);

  useEffect(() => {
    let cancelled = false;
    fetchEntries()
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchEntries]);

  const resolutions = useMemo(() => (entries ?? []).map((entry) => resolveUserTheme(entry, t)), [entries, t]);
  const validUserThemes = useMemo(() => resolutions.filter(isResolvedUserTheme), [resolutions]);
  const invalidUserThemes = useMemo(
    () => resolutions.filter((r): r is UserThemeInvalid => !isResolvedUserTheme(r)),
    [resolutions],
  );

  const cards: Card[] = useMemo(
    () => [
      ...THEMES.map((manifest) => ({ kind: 'builtin' as const, id: manifest.id, manifest })),
      ...validUserThemes.map((resolved) => ({ kind: 'user' as const, id: resolved.id, resolved })),
    ],
    [validUserThemes],
  );

  const isCustom = themeId === CUSTOM_THEME_ID;
  const checkedIndex = cards.findIndex((card) => card.id === themeId);
  // No card is checked in the `custom` state (an Advanced look x palette pairing
  // no manifest names); the first card still needs to be the one Tab reaches.
  const activeIndex = checkedIndex === -1 ? 0 : checkedIndex;

  function focusCard(index: number): void {
    const allCards = rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    allCards?.[index]?.focus();
  }

  function selectCard(card: Card): void {
    if (card.kind === 'builtin') {
      // Theming Phase 5: switching to a built-in theme retires whichever
      // user theme (if any) was active — its DOM props/attrs, its persisted
      // id, and its cache.
      clearUserThemeSelection();
      selectTheme(card.id);
    } else {
      selectUserTheme(card.resolved);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = (index + 1) % cards.length;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = (index - 1 + cards.length) % cards.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = cards.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    selectCard(cards[next]);
    focusCard(next);
  }

  async function handleOpenFolder() {
    setActionError(null);
    setBusy(true);
    try {
      await revealThemesDir();
    } catch (e) {
      setActionError(translateError(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function handleReload() {
    setActionError(null);
    setBusy(true);
    try {
      setEntries(await fetchEntries());
    } catch (e) {
      setActionError(translateError(e, t));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateExample() {
    setActionError(null);
    setBusy(true);
    try {
      const id = await createExampleUserTheme();
      const list = await fetchEntries();
      setEntries(list);
      const created = list.find((e) => e.id === id);
      if (created) {
        const resolved = resolveUserTheme(created, t);
        if (isResolvedUserTheme(resolved)) selectUserTheme(resolved);
      }
    } catch (e) {
      setActionError(translateError(e, t));
    } finally {
      setBusy(false);
    }
  }

  function singleModeBadge(modes: readonly ('dark' | 'light')[]): string | null {
    return modes.length === 1
      ? t(modes[0] === 'dark' ? 'settings.appearance.themes.darkOnlyLabel' : 'settings.appearance.themes.lightOnlyLabel')
      : null;
  }

  let cardIndex = -1;

  return (
    <div className={`theme-picker theme-picker--${variant}`} ref={rootRef}>
      <span className="field-label" id={labelId}>
        {t('settings.appearance.themes.label')}
      </span>
      <div className="theme-picker-grid" role="radiogroup" aria-labelledby={labelId}>
        {THEMES.map((theme) => {
          cardIndex += 1;
          const index = cardIndex;
          const checked = theme.id === themeId;
          const [ground, surface, ink, accent] = theme.swatches;
          const singleModeLabel = singleModeBadge(theme.modes);
          return (
            <button
              key={theme.id}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={index === activeIndex ? 0 : -1}
              className={`theme-card${checked ? ' theme-card--selected' : ''}`}
              onClick={() => selectCard({ kind: 'builtin', id: theme.id, manifest: theme })}
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

      <div className="theme-picker-usersection">
        <div className="theme-picker-usersection-head">
          <span className="field-label" id={userLabelId}>
            {t('settings.appearance.userThemes.groupLabel')}
          </span>
          <div className="theme-picker-user-actions">
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void handleOpenFolder()}>
              {t('settings.appearance.userThemes.openFolder')}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void handleReload()}>
              {t('settings.appearance.userThemes.reload')}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => void handleCreateExample()}>
              {t('settings.appearance.userThemes.createExample')}
            </button>
          </div>
        </div>
        {actionError && <p className="theme-picker-user-error" role="status">{actionError}</p>}
        {validUserThemes.length > 0 && (
          <div className="theme-picker-grid" role="radiogroup" aria-labelledby={userLabelId}>
            {validUserThemes.map((resolved) => {
              cardIndex += 1;
              const index = cardIndex;
              const checked = resolved.id === themeId;
              const [ground, surface, ink, accent] = resolved.swatches;
              const singleModeLabel = singleModeBadge(resolved.modes);
              return (
                <button
                  key={resolved.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={index === activeIndex ? 0 : -1}
                  className={`theme-card theme-card--user${checked ? ' theme-card--selected' : ''}`}
                  onClick={() => selectCard({ kind: 'user', id: resolved.id, resolved })}
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
                      <span className="theme-card-name-text" title={resolved.name}>{resolved.name}</span>
                      <span className="theme-card-badge">{t('settings.appearance.userThemes.customBadge')}</span>
                      {singleModeLabel && <span className="theme-card-badge">{singleModeLabel}</span>}
                    </span>
                    {resolved.description && (
                      <span className="theme-card-description theme-card-description--clamp">
                        {resolved.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {invalidUserThemes.length > 0 && (
          <div className="theme-picker-invalid-list" role="status" aria-labelledby={invalidLabelId}>
            <span className="sr-only" id={invalidLabelId}>
              {t('settings.appearance.userThemes.invalidRegionLabel')}
            </span>
            {invalidUserThemes.map((invalid) => (
              <p key={invalid.id} className="theme-picker-invalid-row">
                {invalid.fileName} — {invalid.error}
              </p>
            ))}
          </div>
        )}
        {validUserThemes.length === 0 && invalidUserThemes.length === 0 && (
          <p className="theme-picker-note">{t('settings.appearance.userThemes.empty')}</p>
        )}
      </div>
    </div>
  );
}
