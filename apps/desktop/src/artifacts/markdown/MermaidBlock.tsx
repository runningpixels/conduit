/// Mermaid → SVG blob `<img>`. The diagram never enters the React tree as HTML
/// (ADR-007). `mermaid` is loaded on demand so the large parser stays off the
/// first paint.

import { useEffect, useId, useState, type ReactNode } from 'react';
import { CopyIcon, CheckIcon } from '../../icons';

export interface MermaidBlockProps {
  source: string;
  fallback?: ReactNode;
}

function mermaidTheme(): 'dark' | 'default' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'dark';
}

/**
 * Give the SVG a concrete pixel size taken from its `viewBox`.
 *
 * Mermaid's `useMaxWidth` output is `width="100%"` plus an inline
 * `max-width: {n}px` on the root. Inside a document that pair means "fill the
 * column, but never grow past your natural size". Through an `<img>` it means
 * neither: the blob is its own document, so the inline cap applies to the SVG
 * within a viewport the `<img>` is sizing from the outside, and the percentage
 * resolves against the container instead. A 135px-wide flowchart was drawn at
 * 716px — a 5.3x upscale, every label with it.
 *
 * With real `width`/`height` attributes the `<img>` has an intrinsic size, and
 * the stylesheet's `max-width: 100%; height: auto` does what it reads as: the
 * diagram at its natural size, scaled down only when it would overflow.
 */
export function sizeSvgFromViewBox(svg: string): string {
  const openTag = /<svg[^>]*>/.exec(svg);
  if (!openTag) return svg;
  const viewBox = /viewBox="\s*([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s*"/.exec(openTag[0]);
  if (!viewBox) return svg;
  const width = Number(viewBox[3]);
  const height = Number(viewBox[4]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return svg;

  const sized = openTag[0]
    .replace(/\swidth="[^"]*"/, '')
    .replace(/\sheight="[^"]*"/, '')
    // The cap is what `width`/`height` now express, and leaving it would fight
    // the stylesheet when the column is narrower than the diagram.
    .replace(/max-width:\s*[^;"]*;?\s*/, '')
    .replace(/<svg/, `<svg width="${width}" height="${height}"`);
  return svg.replace(openTag[0], sized);
}

function svgToBlobUrl(svg: string): string {
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  return URL.createObjectURL(blob);
}

export function MermaidBlock({ source, fallback }: MermaidBlockProps) {
  const reactId = useId().replace(/:/g, '');
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState(mermaidTheme);

  useEffect(() => {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const el = document.documentElement;
    const sync = () => setTheme(mermaidTheme());
    const observer = new MutationObserver(sync);
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    setFailed(false);
    setUrl(null);

    // Nothing to draw. `mermaid.render(id, '')` throws "No diagram type
    // detected", which is not a failure worth reporting to the reader — and
    // every throw used to cost a stray node in `document.body` (below).
    if (!source.trim()) return;

    const id = `conduitMmd${reactId}${Math.floor(Math.random() * 1e6)}`;

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
          // On a parse or draw error mermaid renders its "syntax error" diagram
          // into a temporary `<div id="d{id}">` it appends to `document.body`,
          // then rethrows *before* reaching the code that removes it. The node
          // is never collected: one bomb graphic accumulates at the end of the
          // page per failed render, visible below the app. Suppressed, mermaid
          // removes the temporary node and throws — which is all this wants,
          // since a failure here shows the source instead.
          suppressErrorRendering: true,
          // Labels stay SVG `<text>` rather than `<foreignObject>` HTML. The
          // diagram is shown through an `<img>`, so the blob is an isolated
          // document: it reaches neither the app's stylesheet nor its bundled
          // face, and HTML labels would be laid out against whatever CSS
          // happens to resolve in there. `<text>` is measured and drawn with
          // the same stack, and it keeps model-authored HTML out of the blob.
          htmlLabels: false,
          // Mermaid's default is `"trebuchet ms", verdana, arial` — Trebuchet
          // on Windows and something else on every other platform. Pin it so a
          // diagram is typeset the same way everywhere.
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        });
        const { svg } = await mermaid.render(id, source);
        if (!svg || cancelled) return;
        created = svgToBlobUrl(sizeSvgFromViewBox(svg));
        if (cancelled) {
          URL.revokeObjectURL(created);
          return;
        }
        setUrl(created);
      } catch {
        // Belt to `suppressErrorRendering`'s braces. The flag is the fix; this
        // costs one lookup on a path that already failed, and an orphan that
        // does slip through is never collected.
        if (typeof document !== 'undefined') {
          document.getElementById(`d${id}`)?.remove();
        }
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [source, theme, reactId]);

  async function handleCopy() {
    if (!source) return;
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard can fail in tests / locked-down webviews */
    }
  }

  const sourceFallback = fallback ?? (
    <pre className="md-pre">
      <code>{source}</code>
    </pre>
  );

  // A blank fence renders as nothing at all — not as an empty bordered box.
  if (!source.trim()) return null;

  if (failed) {
    return (
      <div className="md-mermaid">
        <span className="md-render-error" role="note">Couldn’t render diagram</span>
        {sourceFallback}
      </div>
    );
  }

  if (!url) {
    return (
      <div className="md-mermaid" aria-busy="true">
        {sourceFallback}
      </div>
    );
  }

  return (
    <figure className="md-mermaid">
      <div className="md-mermaid-toolbar">
        <span className="md-mermaid-label">mermaid</span>
        <button
          type="button"
          className="icon-btn md-mermaid-copy"
          aria-label={copied ? 'Copied' : 'Copy source'}
          title={copied ? 'Copied' : 'Copy source'}
          onClick={() => void handleCopy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <img className="md-mermaid-img" src={url} alt="Mermaid diagram" />
    </figure>
  );
}
