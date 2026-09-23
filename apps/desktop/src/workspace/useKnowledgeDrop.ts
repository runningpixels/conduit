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
 * Files dragged onto the window from the OS, offered to the knowledge base.
 *
 * Uses Tauri's native drag-drop event rather than HTML5 `dataTransfer`,
 * because only the native event carries real filesystem paths — a browser
 * `File` has none, and the import reads from disk. The native event is on by
 * default (`dragDropEnabled` is unset in `tauri.conf.json`).
 *
 * Returns whether a droppable file is currently hovering, for the overlay.
 */
export function useKnowledgeDrop(onDrop: (paths: string[]) => void): boolean {
  const [hovering, setHovering] = useState(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

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
              if (landsOnComposer(payload.position)) return;
              const paths = knowledgeDropPaths(payload.paths);
              if (paths.length > 0) onDropRef.current(paths);
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
