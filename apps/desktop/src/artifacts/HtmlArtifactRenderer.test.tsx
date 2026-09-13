import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { HtmlArtifactRenderer, assembleArtifactDoc } from './HtmlArtifactRenderer';
import { OFFLINE_ARTIFACT_CSP } from './buildArtifactCsp';
import { ARTIFACT_EXTERNAL_LINK_MESSAGE_TYPE } from './externalUrl';
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