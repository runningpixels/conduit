import { useEffect } from 'react';

export type HotkeyHandler = (event: KeyboardEvent) => void;

export interface HotkeyHandlers {
  /** Mod+N — new chat */
  newChat?: HotkeyHandler;
  /** Mod+, — settings */
  settings?: HotkeyHandler;
  /** Mod+/ — keyboard shortcuts sheet */
  shortcuts?: HotkeyHandler;
  /** Mod+\ — toggle sidebar (V7: the rail is gone; the sidebar collapses) */
  toggleSidebar?: HotkeyHandler;
  /** Mod+J — toggle document panel */
  toggleDocPanel?: HotkeyHandler;
  /** Mod+Shift+E — expand the artifact panel, or restore the layout */
  toggleArtifactExpand?: HotkeyHandler;
  /** Mod+K — open command palette */
  historySearch?: HotkeyHandler;
  /** Mod+Shift+P — cycle the active provider (V7; re-tints the app) */
  cycleProvider?: HotkeyHandler;
  /** Mod+Shift+W — toggle web search for this turn (V7 §9.1) */
  toggleWebSearch?: HotkeyHandler;
  /** Mod+Shift+F — fork conversation at current position (V7 §9.1) */
  forkConversationHere?: HotkeyHandler;
  /** Mod+Shift+C — copy last assistant message */
  copyLastAssistant?: HotkeyHandler;
  /** Mod+1…9 — go to Home, Chats, Apps, Slides, Documents, Library, Workflows, Connectors, Memory */
  goHome?: HotkeyHandler;
  goChats?: HotkeyHandler;
  goApps?: HotkeyHandler;
  goSlides?: HotkeyHandler;
  goDocuments?: HotkeyHandler;
  goLibrary?: HotkeyHandler;
  goWorkflows?: HotkeyHandler;
  goConnectors?: HotkeyHandler;
  goMemory?: HotkeyHandler;
  /** Escape — close menus/dialogs; stop stream when composer focused */
  escape?: HotkeyHandler;
}

export type HotkeyId = Exclude<keyof HotkeyHandlers, 'escape'>;

export interface HotkeyBinding {
  id: HotkeyId;
  /** Compared with `event.key.toLowerCase()`. */
  key: string;
  /**
   * Whether Shift is part of the chord. `'any'` for keys that some layouts
   * only produce with Shift — `/` is Shift+7 on a German keyboard — so the
   * chord still works there.
   */
  shift: boolean | 'any';
  /** How the key is shown in the shortcuts sheet and hints. */
  display: string;
  group: 'general' | 'navigate' | 'layout' | 'chat';
  /** Catalog key naming the action. */
  labelId: string;
}

/**
 * Every Mod shortcut the app binds, in the order the shortcuts sheet lists
 * them. `useHotkeys` matches against this table and the sheet renders it, so a
 * binding cannot be added, changed or dropped in one place and not the other.
 */
export const HOTKEYS: readonly HotkeyBinding[] = [
  { id: 'newChat', key: 'n', shift: false, display: 'N', group: 'general', labelId: 'workspace.shortcuts.action.newChat' },
  { id: 'historySearch', key: 'k', shift: false, display: 'K', group: 'general', labelId: 'workspace.shortcuts.action.historySearch' },
  { id: 'settings', key: ',', shift: false, display: ',', group: 'general', labelId: 'workspace.shortcuts.action.settings' },
  { id: 'shortcuts', key: '/', shift: 'any', display: '/', group: 'general', labelId: 'workspace.shortcuts.action.shortcuts' },
  { id: 'goHome', key: '1', shift: false, display: '1', group: 'navigate', labelId: 'workspace.shortcuts.action.goHome' },
  { id: 'goChats', key: '2', shift: false, display: '2', group: 'navigate', labelId: 'workspace.shortcuts.action.goChats' },
  { id: 'goApps', key: '3', shift: false, display: '3', group: 'navigate', labelId: 'workspace.shortcuts.action.goApps' },
  { id: 'goSlides', key: '4', shift: false, display: '4', group: 'navigate', labelId: 'workspace.shortcuts.action.goSlides' },
  { id: 'goDocuments', key: '5', shift: false, display: '5', group: 'navigate', labelId: 'workspace.shortcuts.action.goDocuments' },
  { id: 'goLibrary', key: '6', shift: false, display: '6', group: 'navigate', labelId: 'workspace.shortcuts.action.goLibrary' },
  { id: 'goWorkflows', key: '7', shift: false, display: '7', group: 'navigate', labelId: 'workspace.shortcuts.action.goWorkflows' },
  { id: 'goConnectors', key: '8', shift: false, display: '8', group: 'navigate', labelId: 'workspace.shortcuts.action.goConnectors' },
  { id: 'goMemory', key: '9', shift: false, display: '9', group: 'navigate', labelId: 'workspace.shortcuts.action.goMemory' },
  { id: 'toggleSidebar', key: '\\', shift: false, display: '\\', group: 'layout', labelId: 'workspace.shortcuts.action.toggleSidebar' },
  { id: 'toggleDocPanel', key: 'j', shift: false, display: 'J', group: 'layout', labelId: 'workspace.shortcuts.action.toggleDocPanel' },
  { id: 'toggleArtifactExpand', key: 'e', shift: true, display: 'E', group: 'layout', labelId: 'workspace.shortcuts.action.toggleArtifactExpand' },
  { id: 'cycleProvider', key: 'p', shift: true, display: 'P', group: 'chat', labelId: 'workspace.shortcuts.action.cycleProvider' },
  { id: 'toggleWebSearch', key: 'w', shift: true, display: 'W', group: 'chat', labelId: 'workspace.shortcuts.action.toggleWebSearch' },
  { id: 'forkConversationHere', key: 'f', shift: true, display: 'F', group: 'chat', labelId: 'workspace.shortcuts.action.forkConversationHere' },
  { id: 'copyLastAssistant', key: 'c', shift: true, display: 'C', group: 'chat', labelId: 'workspace.shortcuts.action.copyLastAssistant' },
];

function isMod(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

/** The binding a keydown fires, if any. Exported for the sheet's tests. */
export function matchHotkey(event: KeyboardEvent): HotkeyBinding | undefined {
  if (!isMod(event)) return undefined;
  const key = event.key.toLowerCase();
  return HOTKEYS.find(
    (binding) => binding.key === key && (binding.shift === 'any' || binding.shift === event.shiftKey),
  );
}

/**
 * App-level keyboard shortcut registry. Mod shortcuts fire from anywhere,
 * text fields included, except during IME composition (Escape always fires).
 * Handlers should call preventDefault.
 */
export function useHotkeys(handlers: HotkeyHandlers): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        handlers.escape?.(event);
        return;
      }

      // Mod shortcuts used to be skipped whenever focus was in a text field.
      // The composer holds focus on open and after every send, so Mod+N,
      // Mod+K, Mod+J… did nothing for most of a session, while the sidebar
      // advertised "New chat Ctrl+N". None of the bindings is a text-editing
      // chord, so they fire from fields too — except mid-IME-composition,
      // where the keystrokes belong to the input method.
      if (event.isComposing) return;
      const binding = matchHotkey(event);
      if (!binding) return;
      event.preventDefault();
      handlers[binding.id]?.(event);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}
