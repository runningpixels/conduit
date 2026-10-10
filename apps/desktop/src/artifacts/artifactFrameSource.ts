/// Where an HTML artifact iframe gets its document from.
///
/// `srcdoc` inherits the embedding page's CSP. In release builds Tauri serves
/// the app with `script-src 'self'` plus hashes, so under `srcdoc` no artifact
/// script ever ran: not the model's code, and not our injected bridges. Inside
/// the app the assembled document is instead handed to Rust (`put_artifact_frame`)
/// and served from the `conduit-artifact` scheme, a real navigation with a
/// fresh policy. The document's own CSP meta then applies, exactly as before.
/// The frame keeps `sandbox="allow-scripts"`, so its origin stays opaque.
///
/// A page with full web access (ADR-007) whose `principal` is known is served
/// from its own origin on Rust's loopback page server instead
/// (`http://<page id>.page.localhost:<port>/<token>`): `pageOrigin` is then
/// set, and only then may the frame add `allow-same-origin`.
///
/// Outside Tauri (unit tests, a plain browser) there is nothing to serve from,
/// so the document goes into `srcdoc` as it always did. If the IPC call fails,
/// the same fallback applies: scripts may then be blocked, which fails safe.
/// A `srcdoc` frame never gets `pageOrigin`: with `allow-same-origin` it would
/// share the app's origin.

import { useEffect, useState } from 'react';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { invokeCommand } from '../ipc/errors';

export const ARTIFACT_FRAME_SCHEME = 'conduit-artifact';

export interface ArtifactFrameSource {
  src?: string;
  srcDoc?: string;
  /** The page's own origin, when `src` is on the page server. */
  pageOrigin?: string;
}

/** Rust's `ServedFrame`. */
interface ServedFrame {
  token: string;
  url?: string | null;
}

function dropFrame(token: string) {
  void invokeCommand('drop_artifact_frame', { token }).catch(() => {});
}

/** The origin of a page-server URL, or undefined for anything else. */
export function pageServerOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || !parsed.hostname.endsWith('.page.localhost')) return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

/// An empty document has nothing to serve and comes back as an empty `srcDoc`.
/// `fullAccess` marks a document rendered with full web access: Rust keeps the
/// loopback guard proxy open only while such a document is served. With
/// `principal` too, the document is served from that page's own origin.
export function useArtifactFrameSource(doc: string, fullAccess = false, principal?: string): ArtifactFrameSource {
  const served = isTauri() && doc !== '';
  const [state, setState] = useState<{ src?: string; pageOrigin?: string; failed: boolean }>({ failed: false });

  useEffect(() => {
    if (!served) return;
    let cancelled = false;
    let token: string | undefined;
    const args = fullAccess
      ? principal
        ? { html: doc, fullAccess: true, principal }
        : { html: doc, fullAccess: true }
      : { html: doc };
    invokeCommand<ServedFrame>('put_artifact_frame', args).then(
      (next) => {
        if (cancelled) {
          dropFrame(next.token);
          return;
        }
        token = next.token;
        const pageOrigin = next.url ? pageServerOrigin(next.url) : undefined;
        setState(
          next.url && pageOrigin
            ? { src: next.url, pageOrigin, failed: false }
            : { src: convertFileSrc(next.token, ARTIFACT_FRAME_SCHEME), failed: false },
        );
      },
      () => {
        if (!cancelled) setState({ failed: true });
      },
    );
    // The previous document stays on screen until the next one is served, so
    // there is no blank flash; releasing its token doesn't unload the frame.
    return () => {
      cancelled = true;
      if (token) dropFrame(token);
    };
  }, [doc, served, fullAccess, principal]);

  if (!served || state.failed) return { srcDoc: doc };
  return state.pageOrigin ? { src: state.src, pageOrigin: state.pageOrigin } : { src: state.src };
}
