/// Sandboxed HTML/JS artifact renderer (M6). Renders model-generated HTML in
/// a locked-down iframe so it CANNOT reach the app, the filesystem, the
/// network (beyond a user-managed passive-resource allowlist), or the parent
/// DOM. This is the one place model content is treated as HTML — by design,
/// contained by the layers below.
///
/// Layers (see docs/adr/adr-007-artifact-rendering-security.md):
/// 1. `sandbox="allow-scripts"` only — NO `allow-same-origin` (null origin →
///    no parent/ambient-DOM access, no same-origin requests to the app), NO
///    `allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-modals`.
/// 2. Strict CSP injected as the FIRST `<meta>` in `<head>`: `connect-src
///    'none'` (the exfiltration guard the sandbox alone doesn't provide),
///    `script-src 'unsafe-inline'` (inline only — never remote scripts),
///    `default-src 'none'`, `base-uri 'none'`, `form-action 'none'`,
///    `navigate-to 'none'`, `frame-ancestors 'none'`. Additional CSP metas in
///    model content can only further RESTRICT, never relax (CSP is monotonic).
/// 3. No Tauri bridge is injected → no `__TAURI__` / filesystem / shell / IPC.
/// 4. Served from the `conduit-artifact` scheme, not `srcdoc`, so the frame
///    doesn't inherit the app's CSP (which blocks every inline script in
///    release builds). Still sandboxed, so the origin stays opaque. Outside
///    Tauri it falls back to `srcdoc`; see `artifactFrameSource.ts`.
/// 5. `referrerpolicy="no-referrer"`.
/// 6. A trusted inline click interceptor posts http(s) link clicks to the
///    parent via `postMessage` so the app can confirm and open them in the
///    system browser. Sandbox flags stay unchanged — this is not a Tauri bridge.
///
/// The `allowlist` widens ONLY passive resource loads (img/font/style) and
/// only with validated http(s) origins; `script-src` and `connect-src` are
/// never widened. Empty allowlist → fully offline.
///
/// Residual risk (documented): a hostile artifact can hang its own frame / burn
/// CPU (DoS). Render-only means no bridge for a liveness heartbeat; mitigated
/// by the user closing the artifact. A watchdog is a future follow-up.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildArtifactCsp, OFFLINE_ARTIFACT_CSP } from './buildArtifactCsp';
import { ARTIFACT_WEBRTC_BLOCK_SCRIPT } from './webrtcBlock';
import { useArtifactFrameSource } from './artifactFrameSource';
import {
  buildShortcutForwarderScript,
  parseArtifactShortcutMessage,
  replayShortcut,
} from './frameShortcuts';
import {
  ARTIFACT_EXTERNAL_LINK_MESSAGE_TYPE,
  parseArtifactExternalLinkMessage,
} from './externalUrl';
import {
  activeRendererTheming,
  readResolvedTokens,
  useThemeRevision,
  type ResolvedTokens,
} from '../themes/resolvedTokens';
import { useT } from '../i18n';
import { markPlaceholdersInHtml } from '../chat/documentBuild';
import {
  ARTIFACT_RUNTIME_ERROR_SCRIPT,
  parseArtifactRuntimeErrorMessage,
  type ArtifactRuntimeError,
} from './runtimeError';
import { ARTIFACT_FORM_SUBMIT_SCRIPT } from './formSubmit';
import {
  ARTIFACT_FETCH_RESULT_MESSAGE_TYPE,
  ARTIFACT_NETWORK_BRIDGE_SCRIPT,
  parseArtifactFetchMessage,
  type ArtifactNetworkHandler,
} from './networkBridge';
import {
  PAGE_BRIDGE_MESSAGE_TYPE,
  buildPageBridgeScript,
  parsePageBridgeRequest,
  type PageBridgeHandler,
  type PageBridgeOutcome,
} from './pageBridge';
import { declaredCapabilities, declaredInputs } from './networkHosts';

export type ArtifactColorScheme = 'light' | 'dark';

export interface HtmlArtifactRendererProps {
  /** The model-generated HTML document fragment (inserted into the iframe body). */
  html: string;
  /** User-managed remote allowlist (validated http(s) origins only). */
  allowlist: string[];
  /** Whether to inject richer app-like baseline styles (typography etc.). */
  styledPreview?: boolean;
  /** Mirrors the app theme so artifact HTML can style itself for dark mode. */
  colorScheme?: ArtifactColorScheme;
  /** Called when the user clicks an http(s) link inside the sandboxed preview. */
  onExternalLink?: (url: string) => void;
  /** Offered when the page's own script throws: drafts a fix request. */
  onAskToFix?: (prompt: string) => void;
  /**
   * Makes the page's `fetch()` a request to this handler (ADR-010). Absent,
   * the page has no network at all — the streaming preview never gets one.
   */
  network?: ArtifactNetworkHandler;
  /**
   * Handles `window.conduit.storage` calls (ADR-012). The bridge script is
   * injected only when the page declares a capability and this is given; a
   * page shown without it (the streaming preview) has no `window.conduit`, so
   * it can feature-detect with `window.conduit?.storage`.
   */
  bridge?: PageBridgeHandler;
  /**
   * The page's launch input values (ADR-013), baked into the bridge script at
   * render — the first value for a given page load is what ships in the
   * srcdoc; later changes to this prop do NOT rebuild the srcdoc (a page
   * mid-session should not reload). Push a later change to the running page
   * with `inputsRevision` instead. Omitted or `undefined` when the page has
   * no inputs (or nothing has supplied values yet): `window.conduit.inputs`
   * is then absent, same convention as `bridge`/`storage`.
   */
  inputValues?: Record<string, unknown>;
  /**
   * Bump this (e.g. after a successful `setAppInputs`) to post the current
   * `inputValues` to the already-loaded frame as an `inputs-changed` message,
   * without rebuilding the srcdoc. A change to `inputValues` alone, with no
   * revision bump, is NOT pushed — that's what lets the initial bake-in
   * happen without immediately re-posting itself.
   */
  inputsRevision?: number;
}

/// Minimal reset so the artifact's own CSS starts from a clean baseline. Kept
/// tiny on purpose — the artifact may bring its own styles (inline only).
const RESET_STYLE = [
  'html,body{margin:0;padding:0;color:inherit;background:transparent;font:inherit}',
  'img{max-width:100%}',
  // The frame is sandboxed srcdoc, so parent CSS cannot reach its scrollbar —
  // without this it renders the default chunky bar inside an otherwise quiet
  // panel. Literal colours because the frame has no access to our tokens. This
  // lives in the reset, not the styled baseline, so it applies even when the
  // "styled preview" pref is off.
  'html{scrollbar-width:thin;scrollbar-color:rgba(145,141,136,.45) transparent}',
].join('\n');

/// Richer baseline applied when `styledPreview` is true. Conservative set:
/// typography, spacing, code, tables, links — no heavy resets or JS.
const STYLED_STYLE_LIGHT = [
  'body{font:14px/1.65 var(--font-ui, system-ui, sans-serif); color:#111}',
  'h1,h2,h3{margin-top:1.4em;margin-bottom:.4em;font-weight:600}',
  'p{margin:.6em 0}',
  'pre,code{font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); background:#f6f7f9; padding:2px 6px; border-radius:4px}',
  'pre{padding:12px 14px; overflow:auto}',
  'table{border-collapse:collapse}',
  'th,td{border:1px solid #ddd; padding:6px 10px; text-align:left}',
  'a{color:#0066cc}',
  'ul,ol{padding-left:1.4em}',
].join('\n');

const STYLED_STYLE_DARK = [
  'body{font:14px/1.65 var(--font-ui, system-ui, sans-serif); color:#e9ebed}',
  'h1,h2,h3{margin-top:1.4em;margin-bottom:.4em;font-weight:600}',
  'p{margin:.6em 0}',
  'pre,code{font-family:var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); background:#191c1f; padding:2px 6px; border-radius:4px}',
  'pre{padding:12px 14px; overflow:auto}',
  'table{border-collapse:collapse}',
  'th,td{border:1px solid #24282d; padding:6px 10px; text-align:left}',
  'a{color:#5eead4}',
  'ul,ol{padding-left:1.4em}',
].join('\n');

/**
 * Token-built equivalent of RESET_STYLE + STYLED_STYLE_LIGHT/DARK, for when
 * `activeRendererTheming('iframe') === 'tokens'` (themes/resolvedTokens.ts):
 * a look × palette this srcdoc's hardcoded light/dark literals were never
 * written for (currently Amber Terminal) gets its preview coloured to match
 * instead of falling back to a fixed light/dark pair that may clash with it.
 *
 * Every value here already passed `resolvedTokens.ts`'s strict hex / font
 * grammar before reaching this function — nothing here re-validates, because
 * nothing here accepts anything else. Literal token values are embedded
 * directly rather than as `var(--font-ui)` references: this stylesheet lives
 * inside the sandboxed `srcdoc` document, which never shares custom
 * properties (or the bundled Geist files) with the app's own document, so a
 * `var()` reference here would silently and permanently resolve to nothing
 * but its fallback. Embedding the resolved stack directly (Geist included)
 * is harmless even though the iframe cannot load that face: an unavailable
 * font in a `font-family` list is normal browser fallback, not an error, so
 * it simply skips to the next name in the same stack.
 *
 * Returns `undefined` — the caller's cue to keep the existing literals —
 * if any token this needs is missing or failed validation.
 */
function buildTokensArtifactStyle(tokens: ResolvedTokens): { reset: string; styled: string } | undefined {
  const required = [tokens.bg, tokens.ink, tokens.link, tokens.card, tokens.line, tokens.fontUi, tokens.fontMono];
  if (required.some((v) => v === undefined)) return undefined;

  const scrollbarThumb = tokens.lineHi ?? (tokens.line as string);

  const reset = [
    'html,body{margin:0;padding:0;color:inherit;background:transparent;font:inherit}',
    'img{max-width:100%}',
    `html{scrollbar-width:thin;scrollbar-color:${scrollbarThumb} transparent}`,
  ].join('\n');

  const styled = [
    `body{font:14px/1.65 ${tokens.fontUi};color:${tokens.ink}}`,
    'h1,h2,h3{margin-top:1.4em;margin-bottom:.4em;font-weight:600}',
    'p{margin:.6em 0}',
    `pre,code{font-family:${tokens.fontMono};background:${tokens.card};padding:2px 6px;border-radius:4px}`,
    'pre{padding:12px 14px;overflow:auto}',
    'table{border-collapse:collapse}',
    `th,td{border:1px solid ${tokens.line};padding:6px 10px;text-align:left}`,
    `a{color:${tokens.link}}`,
    'ul,ol{padding-left:1.4em}',
  ].join('\n');

  return { reset, styled };
}

/// Trusted click interceptor (Conduit-owned, not model content). Captures
/// http(s) anchor clicks and posts them to the parent. In-page `#` anchors are
/// left alone. Not a Tauri bridge — no `__TAURI__`, no IPC inside the frame.
export const ARTIFACT_LINK_INTERCEPTOR_SCRIPT =
  `document.addEventListener('click',function(e){` +
  `var t=e.target;while(t&&t.nodeType===1&&t.tagName!=='A')t=t.parentElement;` +
  `if(!t||t.tagName!=='A')return;` +
  `var raw=t.getAttribute('href')||'';` +
  `if(raw.charAt(0)==='#')return;` +
  `var u;try{u=new URL(raw,document.baseURI);}catch(_){return;}` +
  `if(u.protocol!=='http:'&&u.protocol!=='https:')return;` +
  `e.preventDefault();e.stopPropagation();` +
  `parent.postMessage({type:'${ARTIFACT_EXTERNAL_LINK_MESSAGE_TYPE}',href:u.href},'*');` +
  `},true);`;

/// Assemble the full srcdoc: doctype + our CSP meta (FIRST in head) + reset
/// style + (optional styled baseline) + link interceptor + body with the model
/// HTML. Pure — exported for unit testing. `tokens`, when given, replaces the
/// reset/styled literals with `buildTokensArtifactStyle`'s output (falling
/// back to the existing light/dark literals if it can't fully build one);
/// omitted, this is byte-for-byte what it always was.
/// On Windows, WebView2 runs Tauri's init scripts in every frame (wry can't
/// scope them to the main frame there), so a page finds `__TAURI_INTERNALS__`
/// and `chrome.webview`. Tauri already refuses every call from this origin
/// (no capability grants it). This cuts the channel itself before any page
/// script runs: Tauri's `invoke` and wry's `ipc` are non-writable, but both
/// end in `chrome.webview.postMessage` (the custom-protocol path is blocked by
/// the page's `connect-src 'none'`), which is writable in the frame. Checked
/// live in a release build. ADR 007.
export const ARTIFACT_TAURI_BRIDGE_BLOCK_SCRIPT =
  '(function(){try{var w=window.chrome&&window.chrome.webview;if(w){w.postMessage=function(){};}}catch(e){}})();';

export function assembleArtifactDoc(
  html: string,
  allowlist: string[],
  styledPreview = true,
  colorScheme: ArtifactColorScheme = 'light',
  tokens?: ResolvedTokens,
  network = false,
  capabilities: string[] = [],
  inputs: Record<string, unknown> | null = null,
): string {
  const csp = buildArtifactCsp(allowlist) ?? OFFLINE_ARTIFACT_CSP;
  const tokensStyle = tokens && buildTokensArtifactStyle(tokens);
  const reset = tokensStyle?.reset ?? RESET_STYLE;
  const styled = tokensStyle?.styled ?? (colorScheme === 'dark' ? STYLED_STYLE_DARK : STYLED_STYLE_LIGHT);
  const extra = styledPreview ? `<style>${styled}</style>` : '';
  const hasPageBridge = capabilities.length > 0 || inputs != null;
  return (
    `<!doctype html><html data-theme="${colorScheme}"><head>` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<style>${reset}</style>` +
    extra +
    `<script>${ARTIFACT_TAURI_BRIDGE_BLOCK_SCRIPT}${ARTIFACT_WEBRTC_BLOCK_SCRIPT}${ARTIFACT_RUNTIME_ERROR_SCRIPT}${ARTIFACT_LINK_INTERCEPTOR_SCRIPT}${ARTIFACT_FORM_SUBMIT_SCRIPT}${buildShortcutForwarderScript()}${network ? ARTIFACT_NETWORK_BRIDGE_SCRIPT : ''}${hasPageBridge ? buildPageBridgeScript(capabilities, inputs) : ''}</script>` +
    `</head><body>${html}</body></html>`
  );
}

export function HtmlArtifactRenderer({
  html,
  allowlist,
  styledPreview = true,
  colorScheme = 'light',
  onExternalLink,
  onAskToFix,
  network,
  bridge,
  inputValues,
  inputsRevision,
}: HtmlArtifactRendererProps) {
  const t = useT();
  const themingKind = activeRendererTheming('iframe');
  // Neither the srcdoc's colours nor its own data-theme depend on React
  // props for a tokens-themed artifact, so nothing else forces a re-render
  // when the palette changes underneath it — this is that trigger.
  const themeRevision = useThemeRevision();
  const hasNetwork = network != null;
  const networkRef = useRef(network);
  networkRef.current = network;
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  // The script is only worth injecting when both the page asked for a
  // capability and something can actually answer it — a handler with nothing
  // declared would just be dead code in every other artifact's srcdoc.
  const capabilities = useMemo(() => (bridge ? declaredCapabilities(html) : []), [bridge, html]);
  // Whether the page declares any launch inputs at all (ADR-013) — independent
  // of `bridge`/`capabilities`, since a page can declare inputs without
  // declaring a capability.
  const declaresInputs = useMemo(() => declaredInputs(html).length > 0, [html]);
  // Baked in once per page load: `inputValues` at the moment `html` last
  // changed, kept across re-renders even when the prop changes underneath it.
  // A page must never reload just because its input values changed — later
  // changes reach the frame via the `inputsRevision` effect below instead.
  const lastHtmlRef = useRef(html);
  const bakedInputValuesRef = useRef(inputValues);
  if (html !== lastHtmlRef.current) {
    lastHtmlRef.current = html;
    bakedInputValuesRef.current = inputValues;
  }
  const bakedInputs = declaresInputs && bakedInputValuesRef.current != null ? bakedInputValuesRef.current : null;
  const srcdoc = useMemo(
    () =>
      assembleArtifactDoc(
        markPlaceholdersInHtml(html, (name) => t('chat.documentBuild.pendingSection', { name })),
        allowlist,
        styledPreview,
        colorScheme,
        themingKind === 'tokens' ? readResolvedTokens() : undefined,
        hasNetwork,
        capabilities,
        bakedInputs,
      ),
    [html, allowlist, styledPreview, colorScheme, themingKind, themeRevision, t, hasNetwork, capabilities, bakedInputs],
  );
  const frameSource = useArtifactFrameSource(srcdoc);
  const [loaded, setLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const onExternalLinkRef = useRef(onExternalLink);
  onExternalLinkRef.current = onExternalLink;

  const handleLoad = useCallback(() => {
    setLoaded(true);
  }, []);
  // The first error the current page threw; a new document starts clean.
  const [runtimeError, setRuntimeError] = useState<ArtifactRuntimeError | null>(null);
  useEffect(() => setRuntimeError(null), [srcdoc]);

  // Pushing a later input-values change (ADR-013): `inputValues` always holds
  // the latest prop, read only once `inputsRevision` actually moves — a
  // revision-less change to `inputValues` (e.g. the initial bake landing a
  // render late) must NOT post anything on its own.
  const currentInputValuesRef = useRef(inputValues);
  currentInputValuesRef.current = inputValues;
  const lastPushedRevisionRef = useRef(inputsRevision);
  useEffect(() => {
    if (inputsRevision === undefined || inputsRevision === lastPushedRevisionRef.current) return;
    lastPushedRevisionRef.current = inputsRevision;
    const target = iframeRef.current?.contentWindow;
    if (!target) return;
    target.postMessage(
      { type: PAGE_BRIDGE_MESSAGE_TYPE, event: 'inputs-changed', inputs: currentInputValuesRef.current ?? {} },
      '*',
    );
  }, [inputsRevision]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const shortcut = parseArtifactShortcutMessage(event.data);
      if (shortcut) {
        replayShortcut(shortcut);
        return;
      }
      const runtime = parseArtifactRuntimeErrorMessage(event.data);
      if (runtime) {
        setRuntimeError((current) => current ?? runtime);
        return;
      }
      const request = parseArtifactFetchMessage(event.data);
      if (request) {
        const handler = networkRef.current;
        const target = frame.contentWindow;
        const reply = (result: Awaited<ReturnType<ArtifactNetworkHandler['request']>>) => {
          // The page may have been replaced while the request was out.
          if (!target || iframeRef.current?.contentWindow !== target) return;
          if (result.ok) {
            const { ok: _ok, ...response } = result;
            target.postMessage({ type: ARTIFACT_FETCH_RESULT_MESSAGE_TYPE, id: request.id, ...response }, '*', [
              response.body,
            ]);
          } else {
            target.postMessage({ type: ARTIFACT_FETCH_RESULT_MESSAGE_TYPE, id: request.id, error: result.error }, '*');
          }
        };
        if (!handler) reply({ ok: false, error: 'This page has no network access.' });
        else void handler.request(request).then(reply, (error: unknown) => reply({ ok: false, error: String(error) }));
        return;
      }
      const bridgeRequest = parsePageBridgeRequest(event.data);
      if (bridgeRequest) {
        const handler = bridgeRef.current;
        const target = frame.contentWindow;
        const reply = (outcome: PageBridgeOutcome) => {
          // The page may have been replaced while the call was out.
          if (!target || iframeRef.current?.contentWindow !== target) return;
          target.postMessage({ type: PAGE_BRIDGE_MESSAGE_TYPE, id: bridgeRequest.id, ...outcome }, '*');
        };
        const unavailable = (): PageBridgeOutcome => ({
          ok: false,
          error: { code: 'unavailable', message: 'This page has no storage.' },
        });
        if (!handler) reply(unavailable());
        else {
          try {
            void handler(bridgeRequest.method, bridgeRequest.params).then(reply, () => reply(unavailable()));
          } catch {
            reply(unavailable());
          }
        }
        return;
      }
      const href = parseArtifactExternalLinkMessage(event.data);
      if (!href) return;
      onExternalLinkRef.current?.(href);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div className="artifact-html-wrapper" style={{ position: 'relative', width: '100%', height: '100%' }}>
      {!loaded && (
        <div className="artifact-skeleton" style={{ position: 'absolute', inset: 0, zIndex: 1 }} />
      )}
      {/* Mounted once there is a document: an empty frame would load
          about:blank and fire onLoad, hiding the skeleton too early. */}
      {(frameSource.src || frameSource.srcDoc != null) && (
        <iframe
          ref={iframeRef}
          className="artifact-html-frame"
          title={t('artifacts.html.previewTitle')}
          // `allow-scripts` only. NEVER add allow-same-origin / allow-top-navigation /
          // allow-popups / allow-forms / allow-modals — those would break containment.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={frameSource.src}
          srcDoc={frameSource.srcDoc}
          onLoad={handleLoad}
          style={{ position: 'relative', zIndex: 2 }}
        />
      )}
      {runtimeError && (
        <div className="artifact-runtime-error" role="status">
          <span className="artifact-runtime-error-text" title={runtimeError.message}>
            {t('artifacts.html.runtimeError', { message: runtimeError.message })}
          </span>
          {onAskToFix && (
            <button
              type="button"
              className="btn ghost artifact-runtime-error-fix"
              onClick={() =>
                onAskToFix(
                  runtimeError.line
                    ? t('artifacts.html.fixPromptLine', { message: runtimeError.message, line: runtimeError.line })
                    : t('artifacts.html.fixPrompt', { message: runtimeError.message }),
                )
              }
            >
              {t('artifacts.html.askToFix')}
            </button>
          )}
          <button
            type="button"
            className="icon-btn artifact-runtime-error-dismiss"
            aria-label={t('common.actions.dismiss')}
            onClick={() => setRuntimeError(null)}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
