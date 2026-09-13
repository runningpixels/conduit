/// Mermaid → SVG blob `<img>`. The diagram never enters the React tree as HTML
/// (ADR-007). `mermaid` is loaded on demand so the large parser stays off the
/// first paint.

import { useEffect, useId, useState, type ReactNode } from 'react';
import { CopyIcon, CheckIcon } from '../../icons';
import { mermaidScaleFactor, readMermaidScale, readLook, type MermaidScalePref } from '../../shell/uiPrefs';
import {
  activeRendererTheming,
  readResolvedTokens,
  useThemeRevision,
  type ResolvedTokens,
} from '../../themes/resolvedTokens';
import { useT } from '../../i18n';

export interface MermaidBlockProps {
  source: string;
  fallback?: ReactNode;
  /** Fires once the blob image is ready, or when render fails into the fallback. */
  onReady?: () => void;
}

function mermaidTheme(): 'dark' | 'default' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'default' : 'dark';
}

/**
 * Give the SVG a concrete pixel size taken from its `viewBox`, optionally
 * scaled down for the chat column.
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
 * diagram at its (scaled) natural size, scaled down further only when it would
 * overflow. `scale` defaults to the Appearance "Diagram size" pref (~0.85).
 */
export function sizeSvgFromViewBox(svg: string, scale = mermaidScaleFactor()): string {
  const openTag = /<svg[^>]*>/.exec(svg);
  if (!openTag) return svg;
  const viewBox = /viewBox="\s*([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s*"/.exec(openTag[0]);
  if (!viewBox) return svg;
  const rawW = Number(viewBox[3]);
  const rawH = Number(viewBox[4]);
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) return svg;
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;
  // Round to hundredths so blob URLs stay stable across tiny float noise.
  const width = Math.round(rawW * factor * 100) / 100;
  const height = Math.round(rawH * factor * 100) / 100;

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

/**
 * `mermaid.render`'s `themeVariables` for `theme: 'base'`, built from the
 * live document's resolved tokens (themes/resolvedTokens.ts) so a Mermaid
 * diagram follows whatever look × palette is active instead of Mermaid's own
 * baked-in dark/default themes. Returns `undefined` — the caller's cue to
 * fall back to native theming — if any token this needs failed validation or
 * is unset; a half-built palette (e.g. a border colour missing) is worse
 * than the renderer's own theme.
 */
function buildMermaidThemeVariables(
  tokens: ResolvedTokens,
  look: ReturnType<typeof readLook>,
): Record<string, string> | undefined {
  const background = tokens.bg ?? tokens.card;
  const fontFamily = look === 'terminal' ? tokens.fontMono : tokens.fontUi;
  const required = [
    background,
    tokens.card,
    tokens.ink,
    tokens.lineHi,
    tokens.ink3,
    tokens.cardHi,
    tokens.bgSide,
    tokens.line,
    fontFamily,
  ];
  if (required.some((v) => v === undefined)) return undefined;

  return {
    background: background as string,
    primaryColor: tokens.card as string,
    primaryTextColor: tokens.ink as string,
    primaryBorderColor: tokens.lineHi as string,
    lineColor: tokens.ink3 as string,
    secondaryColor: tokens.cardHi as string,
    tertiaryColor: tokens.bgSide as string,
    textColor: tokens.ink as string,
    mainBkg: tokens.card as string,
    nodeBorder: tokens.lineHi as string,
    clusterBkg: tokens.bgSide as string,
    clusterBorder: tokens.line as string,
    edgeLabelBackground: background as string,
    fontFamily: fontFamily as string,
    fontSize: '12px',
  };
}

export function MermaidBlock({ source, fallback, onReady }: MermaidBlockProps) {
  const t = useT();
  const reactId = useId().replace(/:/g, '');
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState(mermaidTheme);
  const [scalePref, setScalePref] = useState<MermaidScalePref>(readMermaidScale);
  // Bumps on THEME_CHANGED_EVENT (a palette/look write that doesn't touch
  // data-theme, e.g. switching between two dark themes) so tokens theming
  // re-renders even when the MutationObserver below has nothing to fire on.
  const themeRevision = useThemeRevision();

  useEffect(() => {
    if (typeof document === 'undefined' || !document.documentElement) return;
    const el = document.documentElement;
    const sync = () => {
      setTheme(mermaidTheme());
      setScalePref(readMermaidScale());
    };
    const observer = new MutationObserver(sync);
    observer.observe(el, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-mermaid-scale'],
    });
    return () => observer.disconnect();
  }, []);

  const displayScale = mermaidScaleFactor(scalePref);

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

        // Mermaid's `initialize` is global, and `theme`/`themeVariables` are
        // only read at render time, so this has to happen right before every
        // render rather than once — the theme in effect at any earlier call
        // would otherwise win.
        const tokensThemeVariables =
          activeRendererTheming('mermaid') === 'tokens'
            ? buildMermaidThemeVariables(readResolvedTokens(), readLook())
            : undefined;

        if (tokensThemeVariables) {
          mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: 'base',
            themeVariables: tokensThemeVariables,
            darkMode: theme === 'dark',
            // Same rationale as the native branch below.
            suppressErrorRendering: true,
            htmlLabels: false,
          });
        } else {
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
        }
        const { svg } = await mermaid.render(id, source);
        if (!svg || cancelled) return;
        created = svgToBlobUrl(sizeSvgFromViewBox(svg, displayScale));
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
  }, [source, theme, displayScale, reactId, themeRevision]);

  useEffect(() => {
    if (url || failed) onReady?.();
  }, [url, failed, onReady]);

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
        <span className="md-render-error" role="note">{t('artifacts.mermaid.renderError')}</span>
        {sourceFallback}
      </div>
    );
  }

  // Chat's FencePromote holds Prism until onReady and mounts us hidden — return
  // null so we do not flash a second source surface. Without onReady (artifact
  // markdown), keep the source visible until the blob is ready, without the
  // final figure chrome (no toolbar morph).
  if (!url) {
    if (onReady) return null;
    return (
      <div className="md-mermaid-pending" aria-busy="true">
        {sourceFallback}
      </div>
    );
  }

  return (
    <figure className="md-mermaid">
      <div className="md-mermaid-toolbar">
        {/* i18n-exempt: the diagram language identifier, not prose */}
        <span className="md-mermaid-label">mermaid</span>
        <button
          type="button"
          className="icon-btn md-mermaid-copy"
          aria-label={copied ? t('artifacts.mermaid.copied') : t('artifacts.mermaid.copySource')}
          title={copied ? t('artifacts.mermaid.copied') : t('artifacts.mermaid.copySource')}
          onClick={() => void handleCopy()}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
      <img className="md-mermaid-img" src={url} alt={t('artifacts.mermaid.imageAlt')} />
    </figure>
  );
}
