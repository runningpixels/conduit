/*
 * Theme switching: drives `data-theme` on <html> from prefers-color-scheme
 * plus the persisted user toggle in AppSettings.theme (system|dark|light).
 * No new preference store — AppSettings (validated in state.rs) is the source.
 */
import type { AppSettings } from '@conduit/config-schema';

export type ThemeMode = AppSettings['theme'];
/** The two modes the design renders (ADR-011). */
export type EffectiveMode = 'dark' | 'light';

function prefersLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: light)').matches
    : false;
}

/** Resolve the effective theme ('dark' | 'light') for a settings value. */
export function resolveTheme(mode: ThemeMode): EffectiveMode {
  return mode === 'system' ? (prefersLight() ? 'light' : 'dark') : mode;
}

/** Apply the effective theme to <html data-theme>. */
export function applyTheme(mode: ThemeMode): EffectiveMode {
  const effective = resolveTheme(mode);
  document.documentElement.setAttribute('data-theme', effective);
  return effective;
}

/** Install a media-query listener that re-applies the theme when the OS
 *  preference changes (only relevant while mode === 'system'). Returns a
 *  teardown function. */
export function watchSystemTheme(mode: ThemeMode, onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return () => {};
  }
  const mql = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => {
    if (mode === 'system') {
      applyTheme('system');
      onChange();
    }
  };
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}