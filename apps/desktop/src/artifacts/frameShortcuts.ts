/// App shortcuts from inside an HTML artifact preview.
///
/// The preview is a sandboxed frame, so a key pressed after clicking into it
/// never reaches the app's `window` keydown listener: Ctrl+N, Ctrl+K and the
/// rest silently did nothing until focus left the frame. The frame's trusted
/// script (Conduit-owned, see `assembleArtifactDoc`) forwards the chord; the
/// host checks the message came from that frame and replays it on its own
/// window, where `useHotkeys` handles it exactly like a real key press.
///
/// Artifact scripts can post the same message, so only shortcuts that open or
/// rearrange views are forwarded. Ones with side effects — switching the
/// provider, toggling web search, forking a conversation, writing the
/// clipboard — stay unreachable from inside a preview.

import { HOTKEYS, type HotkeyId } from '../workspace/useHotkeys';

export const ARTIFACT_SHORTCUT_MESSAGE_TYPE = 'conduit:artifact-shortcut';

const FORWARDED_HOTKEY_IDS: ReadonlySet<HotkeyId> = new Set([
  'newChat',
  'historySearch',
  'settings',
  'shortcuts',
  'toggleSidebar',
  'toggleDocPanel',
  'toggleArtifactExpand',
]);

/** Bindings a preview may forward, as `[key, shift]` pairs. */
export function forwardedShortcutChords(): Array<[string, boolean | 'any']> {
  return HOTKEYS.filter((binding) => FORWARDED_HOTKEY_IDS.has(binding.id)).map((binding) => [
    binding.key,
    binding.shift,
  ]);
}

/// Script injected into the preview. Forwards allowlisted Mod chords and
/// Escape; everything else (Ctrl+C in the document, typing) is left alone.
export function buildShortcutForwarderScript(): string {
  const chords = JSON.stringify(forwardedShortcutChords());
  return (
    `(function(){var C=${chords};` +
    `document.addEventListener('keydown',function(e){` +
    `var k=(e.key||'').toLowerCase();` +
    `if(k==='escape'){parent.postMessage({type:'${ARTIFACT_SHORTCUT_MESSAGE_TYPE}',key:'Escape',shift:false},'*');return;}` +
    `if(!(e.ctrlKey||e.metaKey))return;` +
    `for(var i=0;i<C.length;i++){if(C[i][0]===k&&(C[i][1]==='any'||C[i][1]===e.shiftKey)){` +
    `e.preventDefault();parent.postMessage({type:'${ARTIFACT_SHORTCUT_MESSAGE_TYPE}',key:k,shift:e.shiftKey},'*');return;}}` +
    `},true);})();`
  );
}

export interface ForwardedShortcut {
  key: string;
  shift: boolean;
}

/// Validate a shortcut message from a preview frame. Returns the chord to
/// replay, or `null` for anything that is not an allowlisted shortcut.
export function parseArtifactShortcutMessage(data: unknown): ForwardedShortcut | null {
  if (data == null || typeof data !== 'object') return null;
  const payload = data as { type?: unknown; key?: unknown; shift?: unknown };
  if (payload.type !== ARTIFACT_SHORTCUT_MESSAGE_TYPE) return null;
  if (typeof payload.key !== 'string' || typeof payload.shift !== 'boolean') return null;
  if (payload.key === 'Escape') return { key: 'Escape', shift: false };
  const key = payload.key.toLowerCase();
  const allowed = forwardedShortcutChords().some(
    ([k, shift]) => k === key && (shift === 'any' || shift === payload.shift),
  );
  return allowed ? { key, shift: payload.shift } : null;
}

/// Replay a forwarded chord on the host window, where `useHotkeys` listens.
export function replayShortcut(shortcut: ForwardedShortcut, target: Window = window): void {
  target.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: shortcut.key,
      ctrlKey: shortcut.key !== 'Escape',
      shiftKey: shortcut.shift,
      bubbles: true,
      cancelable: true,
    }),
  );
}
