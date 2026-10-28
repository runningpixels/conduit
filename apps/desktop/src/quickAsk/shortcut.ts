/// Turning a key press into a shortcut string the global-shortcut plugin
/// parses (`Ctrl+Shift+Space`, `Alt+Q`). Rust validates it again on save.

export type ShortcutPress =
  /** Only modifiers so far: what is held, to show while recording. */
  | { kind: 'partial'; display: string }
  /** A key with no modifier, or one the plugin can't register. */
  | { kind: 'invalid' }
  | { kind: 'complete'; shortcut: string };

type PressLike = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

const MODIFIER_CODES = new Set([
  'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight',
  'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight',
]);

/** `KeyboardEvent.code` values the plugin takes as they are. */
const NAMED_CODES = new Set([
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'Backquote', 'Backslash', 'BracketLeft', 'BracketRight', 'Comma', 'Equal', 'Minus', 'Period',
  'Quote', 'Semicolon', 'Slash', 'Escape',
  'Numpad0', 'Numpad1', 'Numpad2', 'Numpad3', 'Numpad4', 'Numpad5', 'Numpad6', 'Numpad7', 'Numpad8', 'Numpad9',
  'NumpadAdd', 'NumpadDecimal', 'NumpadDivide', 'NumpadEnter', 'NumpadEqual', 'NumpadMultiply', 'NumpadSubtract',
]);

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** The plugin's name for the pressed key, or `null` when it has none. */
export function keyName(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1];
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1];
  m = /^Arrow(Up|Down|Left|Right)$/.exec(code);
  if (m) return m[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return NAMED_CODES.has(code) ? code : null;
}

function modifiers(e: PressLike, mac: boolean): string[] {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push(mac ? 'Option' : 'Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push(mac ? 'Cmd' : 'Super');
  return mods;
}

/** What a key press means for the recorder. */
export function shortcutFromPress(e: PressLike, mac = isMac()): ShortcutPress {
  const mods = modifiers(e, mac);
  if (MODIFIER_CODES.has(e.code)) return { kind: 'partial', display: mods.join('+') };
  const key = keyName(e.code);
  if (!key || mods.length === 0) return { kind: 'invalid' };
  return { kind: 'complete', shortcut: [...mods, key].join('+') };
}
