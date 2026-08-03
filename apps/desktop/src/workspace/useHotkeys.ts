import { useEffect } from 'react';

export type HotkeyHandler = (event: KeyboardEvent) => void;

export interface HotkeyHandlers {
  /** Mod+N — new chat */
  newChat?: HotkeyHandler;
  /** Mod+, — settings */
  settings?: HotkeyHandler;
  /** Mod+B — toggle rail */
  toggleRail?: HotkeyHandler;
  /** Mod+J — toggle document panel */
  toggleDocPanel?: HotkeyHandler;
  /** Mod+K — open command palette */
  historySearch?: HotkeyHandler;
  /** Mod+Shift+P — cycle the active provider (V7; re-tints the app) */
  cycleProvider?: HotkeyHandler;
  /** Mod+Shift+C — copy last assistant message */
  copyLastAssistant?: HotkeyHandler;
  /** Escape — close menus/dialogs; stop stream when composer focused */
  escape?: HotkeyHandler;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function isMod(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

/**
 * App-level keyboard shortcut registry. Skips Mod shortcuts when focus is in an
 * editable field (Escape still fires). Handlers should call preventDefault.
 */
export function useHotkeys(handlers: HotkeyHandlers): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const editable = isEditableTarget(event.target);

      if (event.key === 'Escape') {
        handlers.escape?.(event);
        return;
      }

      if (editable || !isMod(event)) return;

      const key = event.key.toLowerCase();
      if (key === 'n' && !event.shiftKey) {
        event.preventDefault();
        handlers.newChat?.(event);
        return;
      }
      if (key === ',' && !event.shiftKey) {
        event.preventDefault();
        handlers.settings?.(event);
        return;
      }
      if (key === 'b' && !event.shiftKey) {
        event.preventDefault();
        handlers.toggleRail?.(event);
        return;
      }
      if (key === 'j' && !event.shiftKey) {
        event.preventDefault();
        handlers.toggleDocPanel?.(event);
        return;
      }
      if (key === 'k' && !event.shiftKey) {
        event.preventDefault();
        handlers.historySearch?.(event);
        return;
      }
      if (key === 'p' && event.shiftKey) {
        event.preventDefault();
        handlers.cycleProvider?.(event);
        return;
      }
      if (key === 'c' && event.shiftKey) {
        event.preventDefault();
        handlers.copyLastAssistant?.(event);
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}
