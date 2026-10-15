/// A way for a step's form to send the user to the Start panel's Computer
/// section. The canvas editor provides one that selects the Start node; without
/// a provider (the list view shows everything at once) the section is scrolled
/// into view.

import { createContext, useContext } from 'react';

/// Scrolls the Computer section into view once it is on screen.
export function scrollToComputerSettings() {
  window.setTimeout(() => {
    document.querySelector('.wfe-computer')?.scrollIntoView?.({ block: 'center' });
  }, 50);
}

export interface EditorNav {
  openComputerSettings: () => void;
  /// Sets the workflow's folder; absent where the editor can't (the Computer option then only shows its hint).
  setFolder?: (folder: string) => void;
}

export const DEFAULT_NAV: EditorNav = { openComputerSettings: scrollToComputerSettings };

export const EditorNavContext = createContext<EditorNav>(DEFAULT_NAV);

export function useEditorNav() {
  return useContext(EditorNavContext);
}
