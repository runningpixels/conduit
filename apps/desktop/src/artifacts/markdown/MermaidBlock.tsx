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

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
        });
        const id = `conduitMmd${reactId}${Math.floor(Math.random() * 1e6)}`;
        const { svg } = await mermaid.render(id, source);
        if (!svg || cancelled) return;
        created = svgToBlobUrl(svg);
        if (cancelled) {
          URL.revokeObjectURL(created);
          return;
        }
        setUrl(created);
      } catch {
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
