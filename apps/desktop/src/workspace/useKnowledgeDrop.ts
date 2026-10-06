import { useEffect, useRef, useState } from 'react';

/**
 * Extensions the knowledge base can read. Mirrors `PICKER_EXTENSIONS` in
 * `src-tauri/src/commands/knowledge.rs`; the Rust extractor stays the real
 * authority and still refuses anything it can't read, by name.
 */
export const KNOWLEDGE_EXTENSIONS = ['txt', 'md', 'markdown', 'mdown', 'text', 'csv', 'docx', 'pdf'];

/** The dropped paths the knowledge base can take, in drop order. */
export function knowledgeDropPaths(paths: string[]): string[] {
  return paths.filter((path) => {
    const dot = path.lastIndexOf('.');
    return dot >= 0 && KNOWLEDGE_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
  });
}

/** Where a native drop landed, as far as routing cares. */
export type DropZone = 'composer' | 'chat' | 'elsewhere';

/**
 * Does a drop in this zone attach to the message being written? The composer
 * always does (it is the one place that says "attach"). The rest of the chat
 * column -- the thread above it -- does too, but only when the Chats
 * destination is showing a chat (`chatAttaches`): the same ChatView is the dock
 * in Slides and Writing, and the Documents page's whole job is importing, so
 * there a drop outside the composer keeps going to Documents.
 */
export function dropAttaches(zone: DropZone, chatAttaches: boolean): boolean {
  return zone === 'composer' || (zone === 'chat' && chatAttaches);
}

/** Where the pointer is, by what is under it. */
function dropZoneAt(position: { x: number; y: number }): DropZone {
  // The native event reports physical pixels; the DOM works in CSS pixels.
  const scale = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(position.x / scale, position.y / scale);
  if (el?.closest('.composer')) return 'composer';
  if (el?.closest('.tab-pane[data-pane="chat"]')) return 'chat';
  return 'elsewhere';
}

/**
 * Route one native window drop (t1-8 M1, D13): a drop that `attaches` (see
 * `dropAttaches`) goes to the message, exactly as-is (no `knowledgeDropPaths`
 * filter -- the composer takes any file and says, per chip, what it will do
 * with it), and a drop anywhere else goes to Documents (filtered to what the
 * knowledge base can read, as today). Exported so the routing decision itself
 * is unit tested directly, without a Tauri window to drive it through.
 */
export function routeNativeDrop(
  paths: string[],
  attaches: boolean,
  onDrop: (paths: string[]) => void,
  onComposerDrop?: (paths: string[]) => void,
): void {
  if (attaches) {
    if (paths.length > 0) onComposerDrop?.(paths);
    return;
  }
  const droppable = knowledgeDropPaths(paths);
  if (droppable.length > 0) onDrop(droppable);
}

/**
 * Files dragged onto the window from the OS -- one router for both
 * destinations (t1-8 M1, D13). `onDrop` is Documents, as before; `onComposerDrop`
 * is a drop that attaches to the message being written instead: one on the
 * composer, or -- when `chatAttaches` (Chats showing a chat) -- anywhere over
 * the chat column.
 *
 * Uses Tauri's native drag-drop event rather than HTML5 `dataTransfer`,
 * because only the native event carries real filesystem paths — a browser
 * `File` has none, and the import reads from disk. The native event is on by
 * default (`dragDropEnabled` is unset in `tauri.conf.json`), which per
 * Tauri's docs also means WebView2 never fires HTML5 `drop` on Windows — so
 * the composer's own HTML5 handler needs this native path too, and whichever
 * of the two fires first for one physical drop wins (the composer dedupes).
 *
 * Returns what the hovering drag will do, for the highlight: `hovering` is a
 * droppable file about to go to Documents (the window-wide overlay), and
 * `attachHovering` is a file about to attach to the message (the composer
 * lights up; the composer's own HTML5 drag-over never fires on Windows).
 */
export function useKnowledgeDrop(
  onDrop: (paths: string[]) => void,
  onComposerDrop?: (paths: string[]) => void,
  chatAttaches = false,
): { hovering: boolean; attachHovering: boolean } {
  const [hovering, setHovering] = useState(false);
  const [attachHovering, setAttachHovering] = useState(false);
  const chatAttachesRef = useRef(chatAttaches);
  chatAttachesRef.current = chatAttaches;
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;
  const onComposerDropRef = useRef(onComposerDrop);
  onComposerDropRef.current = onComposerDrop;

  useEffect(() => {
    // Not in Tauri (vitest, `pnpm dev:web`): there is no native window to listen to.
    if (!('__TAURI_INTERNALS__' in window)) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // Whether the drag carries anything readable; known only on `enter`.
    let readable = false;
    // Whether the drag carries any file at all (the composer takes any).
    let anyFile = false;
    // One place for what the pointer position means for the highlights.
    const hover = (position: { x: number; y: number }) => {
      const attaches = dropAttaches(dropZoneAt(position), chatAttachesRef.current);
      // Over a spot that attaches, "add to Documents" would be a hint that lies.
      setHovering(readable && !attaches);
      setAttachHovering(anyFile && attaches);
    };

    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          switch (payload.type) {
            case 'enter':
              readable = knowledgeDropPaths(payload.paths).length > 0;
              anyFile = payload.paths.length > 0;
              hover(payload.position);
              break;
            case 'over':
              // Re-checked as the pointer moves between the composer, the
              // thread and the rest of the window.
              hover(payload.position);
              break;
            case 'leave':
              readable = false;
              anyFile = false;
              setHovering(false);
              setAttachHovering(false);
              break;
            case 'drop': {
              readable = false;
              anyFile = false;
              setHovering(false);
              setAttachHovering(false);
              routeNativeDrop(
                payload.paths,
                dropAttaches(dropZoneAt(payload.position), chatAttachesRef.current),
                onDropRef.current,
                onComposerDropRef.current,
              );
              break;
            }
          }
        }),
      )
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Drag-drop is a convenience; the file picker still works without it.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return { hovering, attachHovering };
}
