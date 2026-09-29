import { describe, expect, it, beforeEach } from 'vitest';
import {
  readReduceMotion,
  writeReduceMotion,
  readShowReasoning,
  writeShowReasoning,
  readSendWith,
  writeSendWith,
  applyUiPrefs,
  readExpandedStatus,
  writeExpandedStatus,
  readMermaidScale,
  writeMermaidScale,
  mermaidScaleFactor,
  isBrandActive,
  retiredForcedMode,
  migrateRetiredThemePrefs,
} from './uiPrefs';

describe('uiPrefs (localStorage-backed V7 presentation prefs)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-palette');
    document.documentElement.removeAttribute('data-reduce-motion');
    document.documentElement.removeAttribute('data-expanded-status');
    document.documentElement.removeAttribute('data-mermaid-scale');
  });

  it('reduce motion defaults off and applies the html attribute', () => {
    expect(readReduceMotion()).toBe('off');
    writeReduceMotion('on');
    expect(readReduceMotion()).toBe('on');
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('on');
  });

  it('show reasoning defaults on and round-trips', () => {
    expect(readShowReasoning()).toBe('on');
    writeShowReasoning('off');
    expect(readShowReasoning()).toBe('off');
  });

  it('send with defaults to Enter and round-trips', () => {
    expect(readSendWith()).toBe('enter');
    writeSendWith('cmd-enter');
    expect(readSendWith()).toBe('cmd-enter');
  });

  it('falls back to defaults when storage holds garbage', () => {
    localStorage.setItem('conduit:v7-reduce-motion', '1');
    localStorage.setItem('conduit:v7-show-reasoning', 'true');
    localStorage.setItem('conduit:v7-send-with', 'shift');
    localStorage.setItem('conduit:v9-mermaid-scale', 'huge');
    expect(readReduceMotion()).toBe('off');
    expect(readShowReasoning()).toBe('on');
    expect(readSendWith()).toBe('enter');
    expect(readMermaidScale()).toBe('default');
  });

  it('applyUiPrefs sets every document attribute idempotently', () => {
    writeReduceMotion('on');
    writeExpandedStatus('on');
    writeMermaidScale('compact');
    document.documentElement.removeAttribute('data-reduce-motion');
    document.documentElement.removeAttribute('data-expanded-status');
    document.documentElement.removeAttribute('data-mermaid-scale');
    applyUiPrefs();
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('on');
    expect(document.documentElement.getAttribute('data-expanded-status')).toBe('on');
    expect(document.documentElement.getAttribute('data-mermaid-scale')).toBe('compact');
  });

  it('mermaid scale defaults to 85% and maps prefs to factors', () => {
    expect(readMermaidScale()).toBe('default');
    expect(mermaidScaleFactor('default')).toBe(0.85);
    expect(mermaidScaleFactor('compact')).toBe(0.75);
    expect(mermaidScaleFactor('full')).toBe(1);
    writeMermaidScale('full');
    expect(readMermaidScale()).toBe('full');
    expect(document.documentElement.getAttribute('data-mermaid-scale')).toBe('full');
  });

  it('expanded status defaults to off and round-trips', () => {
    expect(readExpandedStatus()).toBe('off');
    writeExpandedStatus('on');
    expect(readExpandedStatus()).toBe('on');
    expect(localStorage.getItem('conduit:v9-expanded-status')).toBe('on');
  });
});

describe('isBrandActive', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-palette');
  });

  it('is false with no data-palette attribute', () => {
    expect(isBrandActive()).toBe(false);
  });

  it('is true only when data-palette is exactly "brand"', () => {
    document.documentElement.setAttribute('data-palette', 'terra');
    expect(isBrandActive()).toBe(false);
    document.documentElement.setAttribute('data-palette', 'brand');
    expect(isBrandActive()).toBe(true);
  });
});

/**
 * ADR-011 retired the look x palette theme system. These retired keys used to
 * hold the look, the palette, the provider-colour switch, the reading font,
 * and the selected user theme. A dark-only palette (Amber Terminal, Green
 * Phosphor) or light-only palette (Amber Paper) used to force the mode
 * without ever writing AppSettings.theme, so someone on one of those needs
 * that forced mode carried over on the one-time migration; everything else
 * about the retired system is simply discarded.
 */
describe('migrateRetiredThemePrefs (ADR-011 one-time migration)', () => {
  const RETIRED_KEYS = [
    'conduit:v9-palette',
    'conduit:v10-look',
    'conduit:v7-provider-colour',
    'conduit:v10-reading-font',
    'conduit:v10-user-theme',
    'conduit:v10-user-theme-cache',
  ] as const;

  beforeEach(() => {
    localStorage.clear();
    for (const attr of [
      'data-look',
      'data-palette',
      'data-provider-colour',
      'data-reading-font',
      'data-user-palette',
      'data-user-labels',
    ]) {
      document.documentElement.removeAttribute(attr);
    }
  });

  describe('retiredForcedMode', () => {
    it('returns null with nothing stored', () => {
      expect(retiredForcedMode()).toBeNull();
    });

    it('amber and phosphor (dark-only palettes) force dark', () => {
      localStorage.setItem('conduit:v9-palette', 'amber');
      expect(retiredForcedMode()).toBe('dark');
      localStorage.setItem('conduit:v9-palette', 'phosphor');
      expect(retiredForcedMode()).toBe('dark');
    });

    it('paper (light-only palette) forces light', () => {
      localStorage.setItem('conduit:v9-palette', 'paper');
      expect(retiredForcedMode()).toBe('light');
    });

    it('terra and orange-charcoal (dual-mode palettes) force nothing', () => {
      localStorage.setItem('conduit:v9-palette', 'terra');
      expect(retiredForcedMode()).toBeNull();
      localStorage.setItem('conduit:v9-palette', 'orange-charcoal');
      expect(retiredForcedMode()).toBeNull();
    });

    it('a selected user theme whose cache names a single mode forces that mode', () => {
      localStorage.setItem('conduit:v10-user-theme', 'my-theme');
      localStorage.setItem('conduit:v10-user-theme-cache', JSON.stringify({ modes: ['light'] }));
      expect(retiredForcedMode()).toBe('light');
    });

    it('a user theme cache is ignored unless a user theme is actually selected', () => {
      localStorage.setItem('conduit:v10-user-theme-cache', JSON.stringify({ modes: ['light'] }));
      expect(retiredForcedMode()).toBeNull();
    });

    it('a two-mode user theme cache forces nothing', () => {
      localStorage.setItem('conduit:v10-user-theme', 'my-theme');
      localStorage.setItem('conduit:v10-user-theme-cache', JSON.stringify({ modes: ['dark', 'light'] }));
      expect(retiredForcedMode()).toBeNull();
    });

    it('a corrupt cache is treated as "nothing to carry over" rather than throwing', () => {
      localStorage.setItem('conduit:v10-user-theme', 'my-theme');
      localStorage.setItem('conduit:v10-user-theme-cache', '{not json');
      expect(() => retiredForcedMode()).not.toThrow();
      expect(retiredForcedMode()).toBeNull();
    });
  });

  it('clears all six retired keys', () => {
    localStorage.setItem('conduit:v9-palette', 'amber');
    localStorage.setItem('conduit:v10-look', 'brutalist');
    localStorage.setItem('conduit:v7-provider-colour', 'off');
    localStorage.setItem('conduit:v10-reading-font', 'serif');
    localStorage.setItem('conduit:v10-user-theme', 'my-theme');
    localStorage.setItem('conduit:v10-user-theme-cache', JSON.stringify({ modes: ['dark'] }));

    migrateRetiredThemePrefs();

    for (const key of RETIRED_KEYS) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  it('removes data-look, data-provider-colour, and data-reading-font attributes', () => {
    const html = document.documentElement;
    html.setAttribute('data-look', 'brutalist');
    html.setAttribute('data-provider-colour', 'off');
    html.setAttribute('data-reading-font', 'serif');

    migrateRetiredThemePrefs();

    expect(html.getAttribute('data-look')).toBeNull();
    expect(html.getAttribute('data-provider-colour')).toBeNull();
    expect(html.getAttribute('data-reading-font')).toBeNull();
  });

  it('removes data-palette unless it is "brand"', () => {
    document.documentElement.setAttribute('data-palette', 'terra');
    migrateRetiredThemePrefs();
    expect(document.documentElement.getAttribute('data-palette')).toBeNull();

    document.documentElement.setAttribute('data-palette', 'brand');
    migrateRetiredThemePrefs();
    expect(document.documentElement.getAttribute('data-palette')).toBe('brand');
  });

  it('returns the forced mode boot should persist, or null', () => {
    localStorage.setItem('conduit:v9-palette', 'amber');
    expect(migrateRetiredThemePrefs()).toBe('dark');

    localStorage.setItem('conduit:v9-palette', 'terra');
    expect(migrateRetiredThemePrefs()).toBeNull();
  });
});
