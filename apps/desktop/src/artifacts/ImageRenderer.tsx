/// Preview renderer for `image` artifacts (t0-8 M5). Unlike the other
/// renderers in `renderers.tsx`, an image artifact never carries inline
/// `contentText`/`contentJson` — it is always File-content, so this component
/// fetches the bytes itself via the capped `getArtifactContentBytes` (5 MiB,
/// `commands/artifacts.rs`) and wraps them in a `Blob` → blob URL for an
/// `<img>`. Takes the `artifact` directly (see `selectRenderer.ts`'s
/// `buildPreviewProps` — the 'image' case bypasses the File-content
/// null-return exactly because this component is all the artifact it needs).
///
/// Three explicit states: loading (skeleton, matches the document panel's
/// `.artifact-skeleton`), loaded (`<img>`), error (readable text). The over-cap
/// case rejects with a plain "…too large for inline preview…use Export"
/// message (`IpcError`/`invokeCommand`, `ipc/errors.ts`); `String(e)` is that
/// message verbatim — `IpcError.toString()` returns its `fallback` with no
/// wrapping, by design — so the error state below is never a broken-image icon.
///
/// The blob URL is revoked in the effect cleanup (unmount, or whenever the
/// artifact/its bytes could change) — an un-revoked one keeps the decoded
/// image alive in memory for the rest of the session.

import { useEffect, useState } from 'react';
import type { Artifact } from '../ipc/contracts';
import { getArtifactContentBytes } from '../ipc/client';
import { useT } from '../i18n';

export interface ImageRendererProps {
  artifact: Artifact;
}

const FALLBACK_MIME = 'image/png';

export function ImageRenderer({ artifact }: ImageRendererProps) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    void (async () => {
      try {
        const bytes = await getArtifactContentBytes(artifact.id);
        if (cancelled) return;
        const blob = new Blob([Uint8Array.from(bytes)], { type: artifact.mimeType || FALLBACK_MIME });
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id, artifact.mimeType]);

  if (error) {
    return <div className="artifact-image artifact-image-error">{error}</div>;
  }

  if (!url) {
    return (
      <div
        className="artifact-image artifact-skeleton"
        role="status"
        aria-label={t('common.status.loading')}
      />
    );
  }

  return (
    <div className="artifact-image">
      <img
        className="artifact-image-el"
        src={url}
        alt={artifact.title ?? t('artifacts.renderers.image.altFallback')}
      />
    </div>
  );
}
