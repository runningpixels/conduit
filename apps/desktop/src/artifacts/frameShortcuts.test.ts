import { describe, expect, it, vi } from 'vitest';
import {
  ARTIFACT_SHORTCUT_MESSAGE_TYPE,
  buildShortcutForwarderScript,
  parseArtifactShortcutMessage,
  replayShortcut,
} from './frameShortcuts';
import { matchHotkey } from '../workspace/useHotkeys';

const message = (key: string, shift = false) => ({ type: ARTIFACT_SHORTCUT_MESSAGE_TYPE, key, shift });

describe('parseArtifactShortcutMessage', () => {
  it('accepts view shortcuts and Escape', () => {
    expect(parseArtifactShortcutMessage(message('n'))).toEqual({ key: 'n', shift: false });
    expect(parseArtifactShortcutMessage(message('K'))).toEqual({ key: 'k', shift: false });
    expect(parseArtifactShortcutMessage(message('e', true))).toEqual({ key: 'e', shift: true });
    expect(parseArtifactShortcutMessage(message('/', true))).toEqual({ key: '/', shift: true });
    expect(parseArtifactShortcutMessage(message('Escape'))).toEqual({ key: 'Escape', shift: false });
  });

  it('refuses shortcuts with side effects, unbound chords and malformed messages', () => {
    expect(parseArtifactShortcutMessage(message('p', true))).toBeNull(); // cycle provider
    expect(parseArtifactShortcutMessage(message('w', true))).toBeNull(); // toggle web search
    expect(parseArtifactShortcutMessage(message('f', true))).toBeNull(); // fork
    expect(parseArtifactShortcutMessage(message('c', true))).toBeNull(); // copy last message
    expect(parseArtifactShortcutMessage(message('n', true))).toBeNull(); // wrong shift
    expect(parseArtifactShortcutMessage(message('x'))).toBeNull();
    expect(parseArtifactShortcutMessage({ type: 'other', key: 'n', shift: false })).toBeNull();
    expect(parseArtifactShortcutMessage({ type: ARTIFACT_SHORTCUT_MESSAGE_TYPE, key: 'n' })).toBeNull();
    expect(parseArtifactShortcutMessage('conduit:artifact-shortcut')).toBeNull();
  });
});

describe('replayShortcut', () => {
  it('dispatches a keydown the app hotkey table matches', () => {
    const seen: KeyboardEvent[] = [];
    const listener = vi.fn((event: KeyboardEvent) => seen.push(event));
    window.addEventListener('keydown', listener);
    replayShortcut({ key: 'n', shift: false });
    window.removeEventListener('keydown', listener);
    expect(seen).toHaveLength(1);
    expect(matchHotkey(seen[0])?.id).toBe('newChat');
  });
});

describe('buildShortcutForwarderScript', () => {
  it('only lists forwarded chords', () => {
    const script = buildShortcutForwarderScript();
    expect(script).toContain('["n",false]');
    expect(script).not.toContain('["p",true]');
    expect(script).not.toContain('__TAURI__');
  });
});
