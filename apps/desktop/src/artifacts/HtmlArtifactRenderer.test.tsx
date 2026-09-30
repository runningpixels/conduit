import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { ARTIFACT_TAURI_BRIDGE_BLOCK_SCRIPT, HtmlArtifactRenderer, assembleArtifactDoc } from './HtmlArtifactRenderer';
import { OFFLINE_ARTIFACT_CSP } from './buildArtifactCsp';
import { ARTIFACT_EXTERNAL_LINK_MESSAGE_TYPE } from './externalUrl';
import { ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE } from './runtimeError';
import { ARTIFACT_FETCH_MESSAGE_TYPE, ARTIFACT_FETCH_RESULT_MESSAGE_TYPE } from './networkBridge';
import { PAGE_BRIDGE_MESSAGE_TYPE } from './pageBridge';
import type { ResolvedTokens } from '../themes/resolvedTokens';

// Defaults reproduce this file's pre-Phase-3 world (native theming), so every
// existing test below is unaffected; only the dedicated "tokens theming"
// describe block overrides these.
const mockActiveRendererTheming = vi.fn((_kind: 'mermaid' | 'iframe'): 'native' | 'tokens' => 'native');
const mockReadResolvedTokens = vi.fn((): ResolvedTokens => ({}));

vi.mock('../themes/resolvedTokens', () => ({
  activeRendererTheming: (kind: 'mermaid' | 'iframe') => mockActiveRendererTheming(kind),
  readResolvedTokens: () => mockReadResolvedTokens(),
  useThemeRevision: () => 0,
}));

/// Structural assertions only — jsdom does NOT enforce the iframe sandbox or
/// CSP. Behavioral enforcement (script actually blocked from network/parent) is
/// a real-browser (Playwright) gap, noted in
/// `docs/decisions/artifact-rendering-security.md`.

describe('assembleArtifactDoc', () => {
  it('places the CSP <meta> as the FIRST element in <head>', () => {
    const doc = assembleArtifactDoc('<p>hi</p>', []);
    const headOpen = doc.indexOf('<head>');
    const cspMeta = doc.indexOf('<meta http-equiv="Content-Security-Policy"');
    const styleTag = doc.indexOf('<style>');
    expect(cspMeta).toBeGreaterThan(headOpen);
    expect(cspMeta).toBeLessThan(styleTag);
  });

  it('offline doc carries the offline CSP and the model HTML in the body', () => {
    const doc = assembleArtifactDoc('<b>model</b>', []);
    expect(doc).toContain(`content="${OFFLINE_ARTIFACT_CSP}"`);
    expect(doc).toContain('<body><b>model</b></body>');
  });

  it('never injects __TAURI__ (no Tauri bridge) but does inject the link interceptor', () => {
    const doc = assembleArtifactDoc('<p>x</p>', []);
    expect(doc).not.toContain('__TAURI__');
    expect(doc).toContain('<script>');
    expect(doc).toContain('conduit:artifact-external-link');
    expect(doc).toContain('parent.postMessage');
  });

  it('sets data-theme on the iframe document root from colorScheme', () => {
    expect(assembleArtifactDoc('<p>x</p>', [])).toContain('<html data-theme="light">');
    expect(assembleArtifactDoc('<p>x</p>', [], true, 'dark')).toContain('<html data-theme="dark">');
  });
});

describe('HtmlArtifactRenderer', () => {
  beforeEach(() => {
    mockActiveRendererTheming.mockReset().mockReturnValue('native');
    mockReadResolvedTokens.mockReset().mockReturnValue({});
  });

  it('renders an iframe with sandbox="allow-scripts" and no escalation flags', () => {
    const { container } = render(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} />);
    const frame = container.querySelector('iframe');
    expect(frame).not.toBeNull();
    const sandbox = frame?.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).not.toContain('allow-top-navigation');
    expect(sandbox).not.toContain('allow-popups');
    expect(sandbox).not.toContain('allow-forms');
    expect(sandbox).not.toContain('allow-modals');
  });

  it('sets referrerpolicy="no-referrer" and uses srcDoc (not src)', () => {
    const { container } = render(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} />);
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame?.getAttribute('src')).toBeNull();
    expect(frame?.getAttribute('srcdoc')).not.toBeNull();
  });

  it('embeds the model HTML and the CSP meta in srcDoc, with no __TAURI__', () => {
    const { container } = render(
      <HtmlArtifactRenderer html={'<div id="model">hello</div>'} allowlist={[]} />,
    );
    const srcdoc = frame(container)?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('<div id="model">hello</div>');
    expect(srcdoc).toContain('Content-Security-Policy');
    expect(srcdoc).not.toContain('__TAURI__');
    expect(srcdoc).toContain('conduit:artifact-external-link');
  });

  it('applies the allowlist to the CSP in srcDoc (passive origins only)', () => {
    const { container } = render(
      <HtmlArtifactRenderer html="<p>x</p>" allowlist={['https://fonts.example.com']} />,
    );
    const srcdoc = frame(container)?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('https://fonts.example.com');
    // script-src stays inline-only; connect-src stays 'none'.
    expect(srcdoc).toContain("connect-src 'none'");
  });

  it('ignores postMessage events that are not from the iframe contentWindow', () => {
    const onExternalLink = vi.fn();
    render(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} onExternalLink={onExternalLink} />);
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: ARTIFACT_EXTERNAL_LINK_MESSAGE_TYPE,
          href: 'https://example.com',
        },
      }),
    );
    expect(onExternalLink).not.toHaveBeenCalled();
  });
});

describe('assembleArtifactDoc — tokens theming', () => {
  const FULL_TOKENS: ResolvedTokens = {
    bg: '#000000',
    card: '#111111',
    line: '#262626',
    lineHi: '#3a3a3a',
    ink: '#d9d9d9',
    link: '#4fc3f7',
    fontUi: '"Geist Mono", ui-monospace, monospace',
    fontMono: '"Geist Mono", ui-monospace, monospace',
  };

  it('builds the srcdoc stylesheet from resolved tokens when given a full token set', () => {
    const doc = assembleArtifactDoc('<p>x</p>', [], true, 'dark', FULL_TOKENS);
    expect(doc).toContain('color:#d9d9d9');
    expect(doc).toContain('background:#111111');
    expect(doc).toContain('border:1px solid #262626');
    expect(doc).toContain('color:#4fc3f7');
    expect(doc).toContain('"Geist Mono", ui-monospace, monospace');
    expect(doc).toContain('scrollbar-color:#3a3a3a transparent');
    // The fixed light/dark literals never appear once tokens win.
    expect(doc).not.toContain('#e9ebed');
    expect(doc).not.toContain('#5eead4');
    expect(doc).not.toContain('#191c1f');
  });

  it('keeps the exact existing light/dark literals when no tokens are given', () => {
    const native = assembleArtifactDoc('<p>x</p>', [], true, 'dark');
    const withUndefinedTokens = assembleArtifactDoc('<p>x</p>', [], true, 'dark', undefined);
    expect(native).toBe(withUndefinedTokens);
    expect(native).toContain('#e9ebed');
    expect(native).toContain('rgba(145,141,136,.45)');
  });

  it('falls back to the existing literals when a required token is missing', () => {
    const incomplete: ResolvedTokens = { ...FULL_TOKENS, card: undefined };
    const doc = assembleArtifactDoc('<p>x</p>', [], true, 'dark', incomplete);
    const native = assembleArtifactDoc('<p>x</p>', [], true, 'dark');
    expect(doc).toBe(native);
  });
});

describe('HtmlArtifactRenderer — tokens theming', () => {
  const FULL_TOKENS: ResolvedTokens = {
    bg: '#000000',
    card: '#111111',
    line: '#262626',
    lineHi: '#3a3a3a',
    ink: '#d9d9d9',
    link: '#4fc3f7',
    fontUi: '"Geist Mono", ui-monospace, monospace',
    fontMono: '"Geist Mono", ui-monospace, monospace',
  };

  it('renders a token-built srcdoc when activeRendererTheming reports tokens', () => {
    mockActiveRendererTheming.mockReset().mockReturnValue('tokens');
    mockReadResolvedTokens.mockReset().mockReturnValue(FULL_TOKENS);
    const { container } = render(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} />);
    const srcdoc = frame(container)?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('color:#d9d9d9');
    expect(srcdoc).toContain('background:#111111');
    expect(srcdoc).not.toContain('#e9ebed');
  });

  it('keeps the untouched CSP/sandbox attributes under tokens theming', () => {
    mockActiveRendererTheming.mockReset().mockReturnValue('tokens');
    mockReadResolvedTokens.mockReset().mockReturnValue(FULL_TOKENS);
    const { container } = render(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} />);
    const el = frame(container);
    expect(el?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(el?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(el?.getAttribute('srcdoc') ?? '').toContain('Content-Security-Policy');
  });
});

function frame(container: HTMLElement): HTMLElement | null {
  return container.querySelector('iframe');
}
describe('HtmlArtifactRenderer runtime errors', () => {
  // Live: a dashboard's script had `const` without an initializer; the tiles and
  // charts stayed empty and nothing said why.
  const fromFrame = (container: HTMLElement, data: unknown) => {
    const iframe = container.querySelector('iframe')!;
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow }));
    });
  };

  it('registers the error reporter before the page scripts run', () => {
    const doc = assembleArtifactDoc('<script>boom(</script>', []);
    expect(doc.indexOf(ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE)).toBeGreaterThan(-1);
    expect(doc.indexOf(ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE)).toBeLessThan(doc.indexOf('<body>'));
  });

  it('shows the error and drafts a fix request', () => {
    const onAskToFix = vi.fn();
    const { container, getByRole } = render(
      <HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} onAskToFix={onAskToFix} />,
    );
    fromFrame(container, {
      type: ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE,
      message: 'SyntaxError: Missing initializer in const declaration',
      line: 42,
    });
    expect(container.textContent).toContain('Missing initializer in const declaration');
    fireEvent.click(getByRole('button', { name: 'Ask to fix' }));
    expect(onAskToFix).toHaveBeenCalledWith(expect.stringContaining('line 42'));
    expect(onAskToFix.mock.calls[0][0]).toContain('Missing initializer in const declaration');
  });

  it('keeps only the first error, and ignores reports from elsewhere', () => {
    const { container } = render(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE, message: 'not ours' } }),
      );
    });
    expect(container.querySelector('.artifact-runtime-error')).toBeNull();
    fromFrame(container, { type: ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE, message: 'first' });
    fromFrame(container, { type: ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE, message: 'second' });
    expect(container.textContent).toContain('first');
    expect(container.textContent).not.toContain('second');
  });
});

describe('HtmlArtifactRenderer network bridge (ADR-010)', () => {
  const request = {
    type: ARTIFACT_FETCH_MESSAGE_TYPE,
    id: 7,
    url: 'https://api.open-meteo.com/v1/forecast',
    method: 'GET',
    headers: [],
    body: null,
  };

  it('injects the fetch bridge only when a handler is given, with the CSP unchanged', () => {
    const offline = assembleArtifactDoc('<p>x</p>', []);
    const online = assembleArtifactDoc('<p>x</p>', [], true, 'light', undefined, true);
    expect(offline).not.toContain(ARTIFACT_FETCH_MESSAGE_TYPE);
    expect(online).toContain(ARTIFACT_FETCH_MESSAGE_TYPE);
    const csp = (doc: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(doc)?.[1];
    expect(csp(online)).toBe(csp(offline));
    expect(csp(online)).toContain("connect-src 'none'");
    expect(online.indexOf(ARTIFACT_FETCH_MESSAGE_TYPE)).toBeLessThan(online.indexOf('<body>'));
  });

  it('answers a frame request with the handler result, transferring the body', async () => {
    const body = new TextEncoder().encode('{}').buffer;
    const handler = {
      request: vi.fn(async () => ({
        ok: true as const,
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/json']] as Array<[string, string]>,
        url: request.url,
        body,
      })),
    };
    const { container } = render(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} network={handler} />);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('srcdoc') ?? '').toContain(ARTIFACT_FETCH_MESSAGE_TYPE);
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: request, source: iframe.contentWindow }));
    });
    expect(handler.request).toHaveBeenCalledWith(expect.objectContaining({ id: 7, url: request.url, method: 'GET' }));
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: ARTIFACT_FETCH_RESULT_MESSAGE_TYPE, id: 7, status: 200, body }),
      '*',
      [body],
    );
  });

  it('refuses requests without a handler and ignores ones from elsewhere', async () => {
    const handler = { request: vi.fn() };
    const { container, rerender } = render(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} network={handler} />);
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: request }));
    });
    expect(handler.request).not.toHaveBeenCalled();

    rerender(<HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} />);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('srcdoc') ?? '').not.toContain(ARTIFACT_FETCH_MESSAGE_TYPE);
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: request, source: iframe.contentWindow }));
    });
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: ARTIFACT_FETCH_RESULT_MESSAGE_TYPE, id: 7, error: expect.any(String) }),
      '*',
    );
  });
});

describe('HtmlArtifactRenderer page bridge (ADR-012)', () => {
  const storageHtml = '<meta name="conduit-capability" content="storage — keep entries"><p>x</p>';
  const bridgeRequest = {
    type: PAGE_BRIDGE_MESSAGE_TYPE,
    id: 'b1',
    method: 'storage.get',
    params: { key: 'theme' },
  };

  it('injects the bridge script only when the page declares storage AND a handler is given', () => {
    const bridge = vi.fn(async () => ({ ok: true as const, result: null }));

    const { container: neither } = render(<HtmlArtifactRenderer html={storageHtml} allowlist={[]} />);
    const noHandlerSrcdoc = frame(neither)?.getAttribute('srcdoc') ?? '';
    expect(noHandlerSrcdoc).not.toContain(PAGE_BRIDGE_MESSAGE_TYPE);

    const { container: noCapability } = render(
      <HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} bridge={bridge} />,
    );
    expect(frame(noCapability)?.getAttribute('srcdoc') ?? '').not.toContain(PAGE_BRIDGE_MESSAGE_TYPE);

    const { container: both } = render(<HtmlArtifactRenderer html={storageHtml} allowlist={[]} bridge={bridge} />);
    const srcdoc = frame(both)?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(PAGE_BRIDGE_MESSAGE_TYPE);
    // CSP is untouched by the bridge, same as the network bridge.
    const csp = (doc: string) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(doc)?.[1];
    expect(csp(srcdoc)).toBe(csp(noHandlerSrcdoc));
    expect(srcdoc.indexOf(PAGE_BRIDGE_MESSAGE_TYPE)).toBeLessThan(srcdoc.indexOf('<body>'));
  });

  it('reaches the handler with a request from its own frame and posts the reply back', async () => {
    const bridge = vi.fn(async () => ({ ok: true as const, result: 'dark' }));
    const { container } = render(<HtmlArtifactRenderer html={storageHtml} allowlist={[]} bridge={bridge} />);
    const iframe = container.querySelector('iframe')!;
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: bridgeRequest, source: iframe.contentWindow }));
    });
    expect(bridge).toHaveBeenCalledWith('storage.get', { key: 'theme' });
    expect(post).toHaveBeenCalledWith(
      { type: PAGE_BRIDGE_MESSAGE_TYPE, id: 'b1', ok: true, result: 'dark' },
      '*',
    );
  });

  it('ignores a bridge request that does not come from the frame', async () => {
    const bridge = vi.fn(async () => ({ ok: true as const, result: null }));
    render(<HtmlArtifactRenderer html={storageHtml} allowlist={[]} bridge={bridge} />);
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: bridgeRequest }));
    });
    expect(bridge).not.toHaveBeenCalled();
  });

  it('replies "unavailable" when no handler is given, even if the page asks anyway', async () => {
    const { container } = render(<HtmlArtifactRenderer html={storageHtml} allowlist={[]} />);
    const iframe = container.querySelector('iframe')!;
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: bridgeRequest, source: iframe.contentWindow }));
    });
    expect(post).toHaveBeenCalledWith(
      {
        type: PAGE_BRIDGE_MESSAGE_TYPE,
        id: 'b1',
        ok: false,
        error: { code: 'unavailable', message: expect.any(String) },
      },
      '*',
    );
  });
});

describe('HtmlArtifactRenderer launch inputs (ADR-013)', () => {
  const inputsHtml =
    '<script type="application/conduit-inputs+json">[{"id":"city","label":"City","type":"string","default":"Paris"}]</script><p>x</p>';

  it('bakes inputValues into window.conduit.inputs at render, when the page declares inputs', () => {
    const { container } = render(
      <HtmlArtifactRenderer html={inputsHtml} allowlist={[]} inputValues={{ city: 'Paris' }} />,
    );
    const srcdoc = frame(container)?.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain(PAGE_BRIDGE_MESSAGE_TYPE);
    expect(srcdoc).toContain('Paris');
    expect(srcdoc.indexOf(PAGE_BRIDGE_MESSAGE_TYPE)).toBeLessThan(srcdoc.indexOf('<body>'));
  });

  it('has no inputs script when the page declares none, even if inputValues is given', () => {
    const { container } = render(
      <HtmlArtifactRenderer html="<p>x</p>" allowlist={[]} inputValues={{ city: 'Paris' }} />,
    );
    expect(frame(container)?.getAttribute('srcdoc') ?? '').not.toContain(PAGE_BRIDGE_MESSAGE_TYPE);
  });

  it('has no inputs script when the page declares inputs but nothing supplied values yet', () => {
    const { container } = render(<HtmlArtifactRenderer html={inputsHtml} allowlist={[]} />);
    expect(frame(container)?.getAttribute('srcdoc') ?? '').not.toContain(PAGE_BRIDGE_MESSAGE_TYPE);
  });

  it('bumping inputsRevision posts inputs-changed to the frame WITHOUT rebuilding the srcdoc', () => {
    const { container, rerender } = render(
      <HtmlArtifactRenderer html={inputsHtml} allowlist={[]} inputValues={{ city: 'Paris' }} inputsRevision={0} />,
    );
    const iframe = container.querySelector('iframe')!;
    const srcdocBefore = iframe.getAttribute('srcdoc');
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});

    rerender(
      <HtmlArtifactRenderer html={inputsHtml} allowlist={[]} inputValues={{ city: 'Berlin' }} inputsRevision={1} />,
    );

    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toBe(srcdocBefore);
    expect(post).toHaveBeenCalledWith(
      { type: PAGE_BRIDGE_MESSAGE_TYPE, event: 'inputs-changed', inputs: { city: 'Berlin' } },
      '*',
    );
  });

  it('does not post anything when inputValues changes but inputsRevision does not move', () => {
    const { container, rerender } = render(
      <HtmlArtifactRenderer html={inputsHtml} allowlist={[]} inputValues={{ city: 'Paris' }} inputsRevision={0} />,
    );
    const iframe = container.querySelector('iframe')!;
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});

    rerender(
      <HtmlArtifactRenderer html={inputsHtml} allowlist={[]} inputValues={{ city: 'Berlin' }} inputsRevision={0} />,
    );

    expect(post).not.toHaveBeenCalled();
  });
});

describe('the Tauri channel inside a page (ADR 007)', () => {
  it('is cut by the first script, before any other Conduit or page script', () => {
    const doc = assembleArtifactDoc('<script>page()</script>', [], true, 'dark', undefined, true, ['storage']);
    const firstScript = doc.indexOf('<script>') + '<script>'.length;
    expect(doc.slice(firstScript, firstScript + ARTIFACT_TAURI_BRIDGE_BLOCK_SCRIPT.length)).toBe(
      ARTIFACT_TAURI_BRIDGE_BLOCK_SCRIPT,
    );
  });

  it('neuters the webview channel that invoke and ipc both end in', () => {
    const posted: unknown[] = [];
    const webview = { postMessage: (m: unknown) => posted.push(m) };
    const win = {
      chrome: { webview },
      // wry's shim, as injected: it forwards to chrome.webview at call time.
      ipc: { postMessage: (s: unknown) => win.chrome.webview.postMessage(s) },
    };
    new Function('window', ARTIFACT_TAURI_BRIDGE_BLOCK_SCRIPT)(win);
    win.chrome.webview.postMessage('x');
    win.ipc.postMessage('y');
    expect(posted).toEqual([]);
    // A page with none of these (every other platform) is left alone.
    expect(() => new Function('window', ARTIFACT_TAURI_BRIDGE_BLOCK_SCRIPT)({})).not.toThrow();
  });
});
