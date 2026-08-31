/// Bounded ADR-007 exception: the *only* `dangerouslySetInnerHTML` in the
/// markdown path. The TeX source is never assigned to the DOM; only the HTML
/// string returned by KaTeX (`trust: false`, `throwOnError: true`) is.
///
/// See ADR 007 addendum.

import katex from 'katex';
import 'katex/dist/katex.min.css';

export function renderKatexHtml(tex: string, displayMode: boolean): string | null {
  try {
    return katex.renderToString(tex, {
      throwOnError: true,
      displayMode,
      output: 'html',
      trust: false,
      maxSize: 20,
      maxExpand: 1000,
    });
  } catch {
    return null;
  }
}

export interface KatexHtmlProps {
  tex: string;
  displayMode?: boolean;
  /// Shown when KaTeX throws. Defaults to the TeX source as a code chip.
  fallback?: string;
}

export function KatexHtml({ tex, displayMode = false, fallback }: KatexHtmlProps) {
  const html = renderKatexHtml(tex, displayMode);
  if (html == null) {
    const source = fallback ?? tex;
    if (displayMode) {
      return (
        <span className="md-render-error" role="note">
          Couldn’t render math
          <code className="md-code">{source}</code>
        </span>
      );
    }
    return <code className="md-code">{source}</code>;
  }
  return (
    <span
      className={displayMode ? 'md-katex md-katex-display' : 'md-katex md-katex-inline'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
