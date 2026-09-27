/// The pieces a Library section (prompts, skills) hands to whatever hosts it.
///
/// The sections own their behaviour — loading, selection, editing, the IPC
/// calls and their status messages — and render it as four parts: the main
/// action(s), controls above the list, the list, and the selected item's
/// detail. The Library page arranges those parts in its PageFrame; the older
/// sheets that still host a section get `EmbeddedLibraryFrame`, the same
/// list-and-detail in a box that fits inside a sheet.

import type { ReactNode } from 'react';

export interface LibraryLayout {
  /** The section's main action(s). */
  actions: ReactNode;
  /** Controls above the list (a filter). */
  listHeader?: ReactNode;
  /** The list rows. */
  list: ReactNode;
  /** The selected item, the editor, or the empty state. */
  detail: ReactNode;
}

export type LibraryFrame = (layout: LibraryLayout) => ReactNode;

/** List-and-detail inside a sheet, for hosts that are not the Library page. */
export function EmbeddedLibraryFrame({ actions, listHeader, list, detail }: LibraryLayout) {
  return (
    <div className="settings-section library-embed">
      <div className="settings-section-actions">{actions}</div>
      <div className="library-embed-split">
        <div className="library-embed-list scroll">
          {listHeader ? <div className="library-embed-list-head">{listHeader}</div> : null}
          {list}
        </div>
        <div className="library-embed-detail">{detail}</div>
      </div>
    </div>
  );
}

export const embeddedLibraryFrame: LibraryFrame = (layout) => <EmbeddedLibraryFrame {...layout} />;
