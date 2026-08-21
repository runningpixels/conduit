/// Renderer dispatch (M6). Maps an artifact's `kind` (+ optional `mimeType`
/// override) to a `{ Preview, Source }` component pair, and builds the props
/// for each from the artifact's inline content. Pure — no IPC, no context, no
/// JSX (the caller renders `<Preview {...props} />` from its own `.tsx`).
///
/// Selection rules (plan §2):
/// - mimeType overrides kind for `application/json` → JSON, `text/markdown` →
///   Markdown, `text/html` → HTML.
/// - kind markdown → Markdown preview / PlainText source.
/// - kind code → Code preview / PlainText source.
/// - kind json → JSON preview / PlainText (pretty) source.
/// - kind text → PlainText preview / PlainText source.
/// - kind html → HtmlArtifactRenderer preview / PlainText (escaped) source.
/// - unknown kind → PlainText fallback.
///
/// File-content artifacts with no inline text: `buildPreviewProps` returns
/// `null` (the caller shows a "load from disk" affordance / fetches bytes via
/// `getArtifactContentBytes`). For html File-content, the caller must fetch the
/// bytes and pass the decoded HTML to `HtmlArtifactRenderer` directly.

import type { ComponentType } from 'react';
import type { Artifact, ArtifactKind } from '../ipc/contracts';
import { CodeRenderer, JsonRenderer, MarkdownRenderer, PlainTextRenderer } from './renderers';
import type { CodeRendererProps, JsonRendererProps, MarkdownRendererProps, PlainTextRendererProps } from './renderers';
import { HtmlArtifactRenderer } from './HtmlArtifactRenderer';
import type { HtmlArtifactRendererProps } from './HtmlArtifactRenderer';

export interface RendererPair {
  /// `any` because each renderer takes its own prop shape (a member of the
  /// `PreviewProps` union); the caller spreads the built props verbatim.
  Preview: ComponentType<any> | null;
  Source: ComponentType<SourceProps> | null;
}

/// Union of every renderer's prop shape — `buildPreviewProps` returns the
/// member matching the selected renderer.
export type PreviewProps =
  | PlainTextRendererProps
  | CodeRendererProps
  | JsonRendererProps
  | MarkdownRendererProps
  | HtmlArtifactRendererProps;
export type SourceProps = PlainTextRendererProps;

/// Resolve the effective kind, applying mimeType overrides.
export function resolveKind(kind: ArtifactKind, mimeType?: string): ArtifactKind {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'application/json') return 'json';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'text/html') return 'html';
  return kind;
}

/// Select the renderer pair for an artifact (mimeType override applied).
export function selectRenderer(artifact: Artifact): RendererPair {
  const kind = resolveKind(artifact.kind, artifact.mimeType);
  switch (kind) {
    case 'markdown':
      return { Preview: MarkdownRenderer, Source: PlainTextRenderer };
    case 'code':
      return { Preview: CodeRenderer, Source: PlainTextRenderer };
    case 'json':
      return { Preview: JsonRenderer, Source: PlainTextRenderer };
    case 'text':
      return { Preview: PlainTextRenderer, Source: PlainTextRenderer };
    case 'html':
      return { Preview: HtmlArtifactRenderer, Source: PlainTextRenderer };
    default:
      return { Preview: PlainTextRenderer, Source: PlainTextRenderer };
  }
}

/// Inline text for the Preview/Source: prefer `contentText`, fall back to
/// pretty-printed `contentJson`. Empty for File-content artifacts.
export function inlineText(artifact: Artifact): string {
  if (artifact.contentText != null) return artifact.contentText;
  if (artifact.contentJson != null) {
    try {
      return JSON.stringify(artifact.contentJson, null, 2);
    } catch {
      return String(artifact.contentJson);
    }
  }
  return '';
}

/// Build Preview props for the artifact. `allowlist` is the user-managed remote
/// allowlist (HTML artifacts only). `styledPreview` controls whether richer
/// app-like styles are applied (default true). Returns `null` when there is no inline
/// content to preview (File-content without inline text) — the caller renders
/// its own affordance.
export function buildPreviewProps(artifact: Artifact, allowlist: string[], styledPreview = true): PreviewProps | null {
  const kind = resolveKind(artifact.kind, artifact.mimeType);
  const text = inlineText(artifact);
  if (kind !== 'html' && text === '' && artifact.contentJson == null) {
    return null; // File-content (no inline payload) — caller shows a load affordance.
  }
  switch (kind) {
    case 'markdown':
      return { source: text, styledPreview };
    case 'code':
      return { code: text, language: languageFromMime(artifact.mimeType), styledPreview };
    case 'json':
      return { data: artifact.contentJson ?? safeParseJson(text), styledPreview };
    case 'html':
      return { html: text, allowlist, styledPreview };
    case 'text':
    default:
      return { text, styledPreview };
  }
}

/// Build Source props (escaped raw text for every kind).
export function buildSourceProps(artifact: Artifact): SourceProps {
  return { text: inlineText(artifact) };
}

/// A fence-info-string / mimeType hint → language chip label.
export function languageFromMime(mimeType?: string): string | undefined {
  const mime = (mimeType ?? '').toLowerCase();
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'application/json') return 'json';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/plain') return undefined;
  // `text/x-rust` etc. — strip the `text/x-` prefix.
  if (mime.startsWith('text/x-')) return mime.slice('text/x-'.length);
  return undefined;
}

function safeParseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}