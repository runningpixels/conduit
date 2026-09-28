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

/** A drop on the composer means "attach to this message", which the composer
 *  already owns, so the knowledge base must leave it alone. */
function landsOnComposer(position: { x: number; y: number }): boolean {
  // The native event reports physical pixels; the DOM works in CSS pixels.
  const scale = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(position.x / scale, position.y / scale);
  return !!el?.closest('.composer');
}

/**
 * Route one native window drop (t1-8 M1, D13): a drop on the composer attaches
 * to the message, exactly as-is (no `knowledgeDropPaths` filter -- the
 * composer takes any file, the way its own HTML5 handler already does), and a
 * drop anywhere else goes to Documents (filtered to what the knowledge base
 * can read, as today). Exported so the routing decision itself is unit
 * tested directly, without a Tauri window to drive it through.
 */
export function routeNativeDrop(
  paths: string[],
  onComposer: boolean,
  onDrop: (paths: string[]) => void,
  onComposerDrop?: (paths: string[]) => void,
): void {
  if (onComposer) {
    if (paths.length > 0) onComposerDrop?.(paths);
    return;
  }
  const droppable = knowledgeDropPaths(paths);
  if (droppable.length > 0) onDrop(droppable);
}

/**
 * Files dragged onto the window from the OS -- one router for both
 * destinations (t1-8 M1, D13). `onDrop` is Documents, as before; `onComposerDrop`
 * (new) is a drop that lands on the composer, which attaches to the message
 * being written instead.
 *
 * Uses Tauri's native drag-drop event rather than HTML5 `dataTransfer`,
 * because only the native event carries real filesystem paths — a browser
 * `File` has none, and the import reads from disk. The native event is on by
 * default (`dragDropEnabled` is unset in `tauri.conf.json`), which per
 * Tauri's docs also means WebView2 never fires HTML5 `drop` on Windows — so
 * the composer's own HTML5 handler needs this native path too, and whichever
 * of the two fires first for one physical drop wins (the composer dedupes).
 *
 * Returns whether a droppable file is currently hovering, for the overlay
 * (Documents only -- hovering over the composer shows no overlay of its own).
 */
export function useKnowledgeDrop(
  onDrop: (paths: string[]) => void,
  onComposerDrop?: (paths: string[]) => void,
): boolean {
  const [hovering, setHovering] = useState(false);
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

    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent(({ payload }) => {
          switch (payload.type) {
            case 'enter':
              readable = knowledgeDropPaths(payload.paths).length > 0;
              setHovering(readable && !landsOnComposer(payload.position));
              break;
            case 'over':
              // Re-checked as the pointer moves: over the composer the drop
              // will be left to attachments, so promising "add to Documents"
              // there would be a hint that lies.
              setHovering(readable && !landsOnComposer(payload.position));
              break;
            case 'leave':
              readable = false;
              setHovering(false);
              break;
            case 'drop': {
              readable = false;
              setHovering(false);
              routeNativeDrop(
                payload.paths,
                landsOnComposer(payload.position),
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

  return hovering;
}
