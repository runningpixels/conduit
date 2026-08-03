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
} from './uiPrefs';

describe('uiPrefs (localStorage-backed V7 presentation prefs)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-provider-colour');
    document.documentElement.removeAttribute('data-reduce-motion');
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
    expect(readProviderColour()).toBe('on');
    expect(readReduceMotion()).toBe('off');
    expect(readShowReasoning()).toBe('off');
    expect(readSendWith()).toBe('enter');
  });

  it('applyUiPrefs sets both document attributes idempotently', () => {
    writeProviderColour('off');
    writeReduceMotion('on');
    document.documentElement.removeAttribute('data-provider-colour');
    document.documentElement.removeAttribute('data-reduce-motion');
    applyUiPrefs();
    expect(document.documentElement.getAttribute('data-provider-colour')).toBe('off');
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('on');
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
});
