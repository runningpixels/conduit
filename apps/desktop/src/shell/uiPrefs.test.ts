import { describe, expect, it, beforeEach } from 'vitest';
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
});
