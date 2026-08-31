import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  readProviderColour,
  writeProviderColour,
  readReduceMotion,
  writeReduceMotion,
  readShowReasoning,
  writeShowReasoning,
  readSendWith,
  writeSendWith,
  applyUiPrefs,
  readExpandedStatus,
  writeExpandedStatus,
  readPalette,
  writePalette,
  readMermaidScale,
  writeMermaidScale,
  mermaidScaleFactor,
} from './uiPrefs';

describe('uiPrefs (localStorage-backed V7 presentation prefs)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-palette');
    document.documentElement.removeAttribute('data-provider-colour');
    document.documentElement.removeAttribute('data-reduce-motion');
    document.documentElement.removeAttribute('data-expanded-status');
    document.documentElement.removeAttribute('data-mermaid-scale');
  });

  it('provider colour defaults on and applies the html attribute', () => {
    expect(readProviderColour()).toBe('on');
    writeProviderColour('off');
    expect(readProviderColour()).toBe('off');
    expect(document.documentElement.getAttribute('data-provider-colour')).toBe('off');
    writeProviderColour('on');
    expect(document.documentElement.getAttribute('data-provider-colour')).toBe('on');
  });

  it('reduce motion defaults off and applies the html attribute', () => {
    expect(readReduceMotion()).toBe('off');
    writeReduceMotion('on');
    expect(readReduceMotion()).toBe('on');
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('on');
  });

  it('show reasoning defaults off and round-trips', () => {
    expect(readShowReasoning()).toBe('off');
    writeShowReasoning('on');
    expect(readShowReasoning()).toBe('on');
  });

  it('send with defaults to Enter and round-trips', () => {
    expect(readSendWith()).toBe('enter');
    writeSendWith('cmd-enter');
    expect(readSendWith()).toBe('cmd-enter');
  });

  it('falls back to defaults when storage holds garbage', () => {
    localStorage.setItem('conduit:v7-provider-colour', 'maybe');
    localStorage.setItem('conduit:v7-reduce-motion', '1');
    localStorage.setItem('conduit:v7-show-reasoning', 'true');
    localStorage.setItem('conduit:v7-send-with', 'shift');
    localStorage.setItem('conduit:v9-palette', 'anthropic');
    localStorage.setItem('conduit:v9-mermaid-scale', 'huge');
    expect(readPalette()).toBe('orange-charcoal');
    expect(readProviderColour()).toBe('on');
    expect(readReduceMotion()).toBe('off');
    expect(readShowReasoning()).toBe('off');
    expect(readSendWith()).toBe('enter');
    expect(readMermaidScale()).toBe('default');
  });

  it('palette defaults to orange-charcoal and applies the html attribute', () => {
    expect(readPalette()).toBe('orange-charcoal');
    writePalette('terra');
    expect(readPalette()).toBe('terra');
    expect(document.documentElement.getAttribute('data-palette')).toBe('terra');
    writePalette('orange-charcoal');
    expect(document.documentElement.getAttribute('data-palette')).toBe('orange-charcoal');
    writePalette('orange-dark');
    expect(readPalette()).toBe('orange-dark');
    expect(document.documentElement.getAttribute('data-palette')).toBe('orange-dark');
  });

  it('migrates stored conduit palette to terra', () => {
    localStorage.setItem('conduit:v9-palette', 'conduit');
    expect(readPalette()).toBe('terra');
  });

  /* The rename's one real hazard: `claude` no longer validates, so without the
   * migration it would fall through to the default — which is this same look,
   * making the lost preference invisible until the user chose terra. */
  it('migrates the stored claude palette to orange-charcoal', () => {
    localStorage.setItem('conduit:v9-palette', 'claude');
    expect(readPalette()).toBe('orange-charcoal');
  });

  it('applyUiPrefs sets every document attribute idempotently', () => {
    writePalette('orange-charcoal');
    writeProviderColour('off');
    writeReduceMotion('on');
    writeExpandedStatus('on');
    writeMermaidScale('compact');
    document.documentElement.removeAttribute('data-palette');
    document.documentElement.removeAttribute('data-provider-colour');
    document.documentElement.removeAttribute('data-reduce-motion');
    document.documentElement.removeAttribute('data-expanded-status');
    document.documentElement.removeAttribute('data-mermaid-scale');
    applyUiPrefs();
    expect(document.documentElement.getAttribute('data-palette')).toBe('orange-charcoal');
    expect(document.documentElement.getAttribute('data-provider-colour')).toBe('off');
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

  it('provider-colour off neutralizes per-element data-provider hue (CSS rule exists after the hue selectors)', () => {
    // jsdom does not load tokens.css, so computed custom properties cannot be
    // verified there; assert the rule text in the real stylesheet instead.
    // (vitest rewrites import.meta.url to an http dev-server URL and returns
    // empty modules for CSS, so resolve the file from the process cwd.)
    const css = readFileSync(
      `${process.cwd()}/../../packages/ui/src/tokens.css`,
      'utf8',
    );
    const hueSelector = '[data-provider="anthropic"]';
    const neutralize = 'html[data-provider-colour="off"] [data-provider]';
    expect(css).toContain(hueSelector);
    expect(css).toContain(neutralize);
    // The neutralizer must come after the hue selectors so it wins the cascade.
    expect(css.indexOf(neutralize)).toBeGreaterThan(css.indexOf(hueSelector));
    // And the main rule pins --hue to the neutral ink scale (the first
    // occurrence may be the no-color-mix fallback, so match the full rule).
    const normalized = css.replace(/\r\n/g, '\n');
    expect(normalized).toContain(
      'html[data-provider-colour="off"] [data-provider] {\n  --hue: var(--ink-2);',
    );
  });

  /**
   * Three rules now compete for --hue at near-equal specificity, and two of the
   * three pairings are settled by source order alone. Order is therefore a
   * contract, not a formatting detail.
   */
  it('orders the orange-charcoal pin after the provider hues and before the off switch', () => {
    const css = readFileSync(`${process.cwd()}/../../packages/ui/src/tokens.css`, 'utf8');
    const hue = css.indexOf('[data-provider="anthropic"]');
    const pin = css.indexOf('html[data-palette="orange-charcoal"] [data-provider]');
    const odPin = css.indexOf('html[data-palette="orange-dark"] [data-provider]');
    const off = css.indexOf('html[data-provider-colour="off"] [data-provider]');
    expect(pin).toBeGreaterThan(-1);
    expect(odPin).toBeGreaterThan(-1);
    // (0,2,1) beats the provider rules' (0,1,0)/(0,2,0) outright, but the rule
    // still has to exist after them to read as intentional.
    expect(pin).toBeGreaterThan(hue);
    expect(odPin).toBeGreaterThan(hue);
    // Equal specificity with the off switch, so this ordering is the only thing
    // making "provider colour: off" beat the palette's accent.
    expect(off).toBeGreaterThan(pin);
    expect(off).toBeGreaterThan(odPin);
  });

  /**
   * <html> carries data-theme, data-provider and data-provider-colour at once.
   * With only the single-member selector, [data-theme="light"][data-provider=x]
   * at (0,2,0) outranked the off switch at (0,1,1), so in light mode everything
   * reading --hue from <html> — composer focus ring, .btn.primary, the focus
   * outline via --ring-color — stayed tinted with the toggle off.
   */
  it('neutralizes the html-level hue at a specificity light mode cannot beat', () => {
    const css = readFileSync(`${process.cwd()}/../../packages/ui/src/tokens.css`, 'utf8')
      .replace(/\r\n/g, '\n');
    expect(css).toContain('html[data-provider-colour="off"][data-provider]');
  });
});
