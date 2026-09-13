/**
 * Theming Phase 3 — resolved-token bridge tests. Validation is the load-
 * bearing part (these values get interpolated into a Mermaid config and an
 * iframe `srcdoc` stylesheet), so it gets direct coverage against both
 * malicious/malformed input and real token values.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeRendererTheming,
  isStrictHexColor,
  isValidFontStack,
  readResolvedTokens,
  useThemeRevision,
} from './resolvedTokens';
import { renderHook, act } from '@testing-library/react';
import {
  readLook,
  selectTheme,
  THEME_CHANGED_EVENT,
  writeLook,
  writePalette,
} from '../shell/uiPrefs';

function resetHtml() {
  const el = document.documentElement;
  for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
  el.removeAttribute('style');
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
}

describe('isStrictHexColor', () => {
  it('accepts #rgb and #rrggbb', () => {
    expect(isStrictHexColor('#fff')).toBe(true);
    expect(isStrictHexColor('#a1B2c3')).toBe(true);
  });

  it('rejects alpha hex, named colours, and functional/CSS-breaking text', () => {
    expect(isStrictHexColor('#ffffffff')).toBe(false); // #rrggbbaa
    expect(isStrictHexColor('red')).toBe(false);
    expect(isStrictHexColor('rgb(0,0,0)')).toBe(false);
    expect(isStrictHexColor('url(evil.css)')).toBe(false);
    expect(isStrictHexColor('#fff; background: url(x)')).toBe(false);
    expect(isStrictHexColor('#fff}body{color:red')).toBe(false);
    expect(isStrictHexColor('expression(alert(1))')).toBe(false);
    expect(isStrictHexColor('')).toBe(false);
    expect(isStrictHexColor(undefined)).toBe(false);
  });
});

describe('isValidFontStack', () => {
  it('accepts real token font stacks', () => {
    expect(isValidFontStack('"Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif')).toBe(
      true,
    );
    expect(isValidFontStack('"Geist Mono", ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace')).toBe(true);
  });

  it('rejects injection-shaped and malformed values', () => {
    expect(isValidFontStack('"Geist", url(evil.css)')).toBe(false);
    expect(isValidFontStack('Geist; } body { color: red')).toBe(false);
    expect(isValidFontStack('expression(alert(1))')).toBe(false);
    expect(isValidFontStack('"unterminated')).toBe(false);
    expect(isValidFontStack('')).toBe(false);
    expect(isValidFontStack('a'.repeat(301))).toBe(false);
    expect(isValidFontStack(undefined)).toBe(false);
  });
});

describe('readResolvedTokens', () => {
  beforeEach(resetHtml);
  afterEach(resetHtml);

  it('reads validated hex and font values from the live document', () => {
    const el = document.documentElement;
    el.style.setProperty('--bg', '#111111');
    el.style.setProperty('--ink', '#eeeeee');
    el.style.setProperty('--font-ui', '"Geist", sans-serif');
    const tokens = readResolvedTokens();
    expect(tokens.bg).toBe('#111111');
    expect(tokens.ink).toBe('#eeeeee');
    expect(tokens.fontUi).toBe('"Geist", sans-serif');
  });

  it('omits a token that fails validation rather than passing it through', () => {
    const el = document.documentElement;
    el.style.setProperty('--bg', 'red');
    el.style.setProperty('--link', 'url(javascript:alert(1))');
    el.style.setProperty('--font-mono', 'mono; } body { color: red');
    const tokens = readResolvedTokens();
    expect(tokens.bg).toBeUndefined();
    expect(tokens.link).toBeUndefined();
    expect(tokens.fontMono).toBeUndefined();
  });

  it('omits an unset token', () => {
    const tokens = readResolvedTokens();
    expect(tokens.card).toBeUndefined();
  });
});

describe('activeRendererTheming', () => {
  beforeEach(resetHtml);
  afterEach(resetHtml);

  it('returns the named manifest field for a registered theme', () => {
    selectTheme('amber-terminal');
    expect(activeRendererTheming('mermaid')).toBe('tokens');
    expect(activeRendererTheming('iframe')).toBe('tokens');
  });

  it('returns native for the default (soft, orange-charcoal) theme', () => {
    selectTheme('conduit-orange-charcoal');
    expect(activeRendererTheming('mermaid')).toBe('native');
    expect(activeRendererTheming('iframe')).toBe('native');
  });

  it('custom pairing (no manifest) with a non-soft look defers to tokens', () => {
    writeLook('terminal');
    writePalette('terra'); // terminal x terra names no manifest -> custom
    expect(readLook()).toBe('terminal');
    expect(activeRendererTheming('mermaid')).toBe('tokens');
    expect(activeRendererTheming('iframe')).toBe('tokens');
  });

  it('custom pairing with the soft look stays native', () => {
    writeLook('soft');
    writePalette('amber'); // soft x amber names no manifest -> custom, but soft
    expect(activeRendererTheming('mermaid')).toBe('native');
  });

  it('a brand always wins native, even over a tokens-theming manifest', () => {
    selectTheme('amber-terminal');
    document.documentElement.setAttribute('data-palette', 'brand');
    expect(activeRendererTheming('mermaid')).toBe('native');
    expect(activeRendererTheming('iframe')).toBe('native');
  });
});

describe('useThemeRevision', () => {
  beforeEach(resetHtml);
  afterEach(resetHtml);

  it('bumps on THEME_CHANGED_EVENT', () => {
    const { result } = renderHook(() => useThemeRevision());
    const initial = result.current;
    act(() => {
      window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT));
    });
    expect(result.current).toBe(initial + 1);
  });

  it('bumps when data-theme changes on <html>', async () => {
    const { result } = renderHook(() => useThemeRevision());
    const initial = result.current;
    document.documentElement.setAttribute('data-theme', 'light');
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeGreaterThan(initial);
  });
});
