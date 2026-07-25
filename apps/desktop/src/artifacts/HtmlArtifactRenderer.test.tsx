import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { HtmlArtifactRenderer, assembleArtifactDoc } from './HtmlArtifactRenderer';
import { OFFLINE_ARTIFACT_CSP } from './buildArtifactCsp';

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

  it('never injects __TAURI__ or any script of our own', () => {
    const doc = assembleArtifactDoc('<p>x</p>', []);
    expect(doc).not.toContain('__TAURI__');
    expect(doc).not.toMatch(/<script/i);
  });

  it('sets data-theme on the iframe document root from colorScheme', () => {
    expect(assembleArtifactDoc('<p>x</p>', [])).toContain('<html data-theme="light">');
    expect(assembleArtifactDoc('<p>x</p>', [], true, 'dark')).toContain('<html data-theme="dark">');
  });
});

describe('HtmlArtifactRenderer', () => {
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
});

function frame(container: HTMLElement): HTMLElement | null {
  return container.querySelector('iframe');
}