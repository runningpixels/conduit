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
/// Outside Tauri (unit tests, a plain browser) there is nothing to serve from,
/// so the document goes into `srcdoc` as it always did. If the IPC call fails,
/// the same fallback applies: scripts may then be blocked, which fails safe.

import { useEffect, useState } from 'react';
import { convertFileSrc, isTauri } from '@tauri-apps/api/core';
import { invokeCommand } from '../ipc/errors';

export const ARTIFACT_FRAME_SCHEME = 'conduit-artifact';

export interface ArtifactFrameSource {
  src?: string;
  srcDoc?: string;
}

function dropFrame(token: string) {
  void invokeCommand('drop_artifact_frame', { token }).catch(() => {});
}

/// An empty document has nothing to serve and comes back as an empty `srcDoc`.
/// `fullAccess` marks a document rendered with full web access: Rust keeps the
/// loopback guard proxy open only while such a document is served.
export function useArtifactFrameSource(doc: string, fullAccess = false): ArtifactFrameSource {
  const served = isTauri() && doc !== '';
  const [state, setState] = useState<{ src?: string; failed: boolean }>({ failed: false });

  useEffect(() => {
    if (!served) return;
    let cancelled = false;
    let token: string | undefined;
    invokeCommand<string>('put_artifact_frame', fullAccess ? { html: doc, fullAccess: true } : { html: doc }).then(
      (next) => {
        if (cancelled) {
          dropFrame(next);
          return;
        }
        token = next;
        setState({ src: convertFileSrc(next, ARTIFACT_FRAME_SCHEME), failed: false });
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
  }, [doc, served, fullAccess]);

  if (!served || state.failed) return { srcDoc: doc };
  return { src: state.src };
}
