import { describe, expect, it } from 'vitest';
import { EXPORT_CSP, buildDeckHtmlExport, buildDeckPrintHtml } from './deckExport';

const deck = {
  title: 'Q3 <platform> & "migration"',
  themeCss: '.slide { background: #123; } /* </style><p>escaped</p> */',
  slides: [
    { layout: 'title', html: '<h1 class="headline">One</h1><script>alert(1)</script>', notes: 'Say <b>hi</b> & wave' },
    { layout: 'bullets', html: '<p onclick="steal()">Two</p>', notes: '' },
    { layout: 'quote', html: '<p>Three</p>', notes: 'last' },
  ],
};

describe('buildDeckHtmlExport', () => {
  const html = buildDeckHtmlExport(deck, { lang: 'en', generator: 'Conduit' });

  it('is a standalone document with the policy, title and generator', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('name="viewport"');
    expect(html).toContain(`http-equiv="Content-Security-Policy" content="${EXPORT_CSP}"`);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('<title>Q3 &lt;platform&gt; &amp; "migration"</title>');
    expect(html).toContain('<meta name="generator" content="Conduit">');
    expect(html).toContain('<html lang="en">');
  });

  it('ignores a language that is not a plain tag and escapes the generator', () => {
    const odd = buildDeckHtmlExport(deck, { lang: 'en"><script>', generator: 'A"B' });
    expect(odd).not.toContain('lang=');
    expect(odd).toContain('content="A&quot;B"');
  });

  it('has one section per slide with its layout', () => {
    expect(html.match(/<section class="slide"/g)).toHaveLength(3);
    expect(html).toContain('data-layout="bullets"');
  });

  it('strips slide scripts and inline handlers, and the theme cannot close its style', () => {
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('</style><p>escaped');
    // The only script element is the presenter's own.
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('keeps speaker notes as escaped hidden asides, only where there are notes', () => {
    expect(html).toContain('<aside class="notes">Say &lt;b&gt;hi&lt;/b&gt; &amp; wave</aside>');
    expect(html.match(/<aside class="notes">/g)).toHaveLength(2);
  });

  it('loads nothing external', () => {
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\b(src|href)=/);
    expect(html).not.toMatch(/@import/);
  });

  it('carries a navigation script that parses and covers the documented keys', () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    expect(() => new Function(script)).not.toThrow();
    for (const key of ['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', 'Home', 'End', "' '", "'f'", "'n'", "'o'"]) {
      expect(script).toContain(key);
    }
    expect(script).toContain('hashchange');
    expect(script).toContain('requestFullscreen');
    expect(script).toContain('contextmenu');
  });
});

describe('buildDeckPrintHtml', () => {
  const html = buildDeckPrintHtml(deck);

  it('sets the page to 1920x1080 with no margin and prints backgrounds', () => {
    expect(html).toContain('@page { size: 1920px 1080px; margin: 0; }');
    expect(html).toContain('print-color-adjust: exact');
  });

  it('has one page-break rule and one section per slide, and no script', () => {
    expect(html).toContain('break-after: page');
    expect(html.match(/<section class="slide"/g)).toHaveLength(3);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('onclick');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('is served under a policy that allows no script', () => {
    expect(html).toContain("default-src 'none'");
    expect(html).not.toContain("script-src");
  });
});
