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

export function useArtifactFrameSource(doc: string): ArtifactFrameSource {
  const served = isTauri();
  const [state, setState] = useState<{ src?: string; failed: boolean }>({ failed: false });

  useEffect(() => {
    if (!served) return;
    let cancelled = false;
    let token: string | undefined;
    invokeCommand<string>('put_artifact_frame', { html: doc }).then(
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
  }, [doc, served]);

  if (!served || state.failed) return { srcDoc: doc };
  return { src: state.src };
}
