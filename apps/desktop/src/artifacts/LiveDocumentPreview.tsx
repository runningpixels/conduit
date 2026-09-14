/// A document rendered while the model is still writing it.
///
/// Off by default (`uiPrefs.readDocumentPeek`): the pending panel's job is to
/// show that work is happening, not the document. When the user turns it on,
/// this re-reads the streaming tool call about once a second and renders what
/// has arrived.
///
/// HTML goes through `assembleArtifactDoc` into a frame with the same sandbox
/// and CSP as the finished preview (ADR-007), so a half-written document gets
/// no capability the finished one would not. Model `<script>` blocks and inline
/// handlers are stripped first — best effort, not a security boundary (the
/// sandbox is) — because a script cut off mid-statement is noise, and they run
/// once the document is done. Each update loads into a hidden frame and swaps
/// in on load, so the preview does not flash white every second, and a trusted
/// line at the end keeps the view on the part being written.

import { useEffect, useMemo, useState } from 'react';
import { assembleArtifactDoc, type ArtifactColorScheme } from './HtmlArtifactRenderer';
import { MarkdownRenderer } from './renderers';
import { decodePartialContent } from '../chat/documentWriteScan';
import { useNow } from '../lib/useNow';
import { useT } from '../i18n';

/** Stop re-rendering past this many characters; a preview is not worth the CPU. */
export const LIVE_PREVIEW_MAX_CHARS = 1_000_000;

export interface LiveDocumentSource {
  toolName: string;
  argumentsText: string;
}

/// Remove script elements and inline event handlers from partial HTML.
export function withoutScripts(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?(<\/script\s*>|$)/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}

const FOLLOW_END_SCRIPT = '<script>scrollTo(0,document.documentElement.scrollHeight)</script>';

function PeekHtmlFrames({
  html,
  allowlist,
  styledPreview,
  colorScheme,
}: {
  html: string;
  allowlist: string[];
  styledPreview: boolean;
  colorScheme: ArtifactColorScheme;
}) {
  const t = useT();
  const doc = useMemo(
    () => assembleArtifactDoc(withoutScripts(html) + FOLLOW_END_SCRIPT, allowlist, styledPreview, colorScheme),
    [html, allowlist, styledPreview, colorScheme],
  );
  const [frames, setFrames] = useState<{ a: string; b: string; shown: 'a' | 'b' }>({ a: doc, b: '', shown: 'a' });

  useEffect(() => {
    setFrames((current) => {
      const hidden = current.shown === 'a' ? 'b' : 'a';
      if (current[current.shown] === doc || current[hidden] === doc) return current;
      return { ...current, [hidden]: doc };
    });
  }, [doc]);

  const frame = (name: 'a' | 'b') => (
    <iframe
      key={name}
      className="artifact-html-frame live-preview-frame"
      data-shown={frames.shown === name ? 'true' : 'false'}
      title={t('artifacts.html.previewTitle')}
      // Same containment as the finished preview; never widen.
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={frames[name]}
      onLoad={() =>
        setFrames((current) => (current.shown !== name && current[name] ? { ...current, shown: name } : current))
      }
    />
  );

  return (
    <div className="live-preview-frames">
      {frame('a')}
      {frame('b')}
    </div>
  );
}

export function LiveDocumentPreview({
  kind,
  readSource,
  allowlist,
  styledPreview = true,
  colorScheme = 'light',
}: {
  kind: string;
  readSource: () => LiveDocumentSource | null;
  allowlist: string[];
  styledPreview?: boolean;
  colorScheme?: ArtifactColorScheme;
}) {
  const t = useT();
  const now = useNow(true, 1000);
  const [content, setContent] = useState('');

  useEffect(() => {
    const source = readSource();
    if (!source) return;
    const decoded = decodePartialContent(source.toolName, source.argumentsText);
    if (decoded !== undefined && decoded.length <= LIVE_PREVIEW_MAX_CHARS) setContent(decoded);
  }, [now, readSource]);

  const source = readSource();
  if (source && source.argumentsText.length > LIVE_PREVIEW_MAX_CHARS) {
    return <p className="artifact-pending-copy">{t('workspace.documentPanel.pending.peekTooLarge')}</p>;
  }
  if (!content) return <div className="artifact-skeleton" aria-hidden="true" />;
  if (kind === 'html') {
    return <PeekHtmlFrames html={content} allowlist={allowlist} styledPreview={styledPreview} colorScheme={colorScheme} />;
  }
  if (kind === 'markdown') {
    return <MarkdownRenderer source={content} styledPreview={styledPreview} />;
  }
  return <pre className="live-preview-text">{content}</pre>;
}
