import { describe, expect, it } from 'vitest';
import { DECK_FRAME_HTML, cleanInlineHtml, deckMessage, parseDeckEvent } from './deckDocument';
import { DECK_FIT_SCRIPT } from './deckFit';
import { STARTER_THEMES, THEME_CONTRACT } from './themes';

const deck = {
  themeCss: '.slide{color:red}',
  slides: [
    { id: 's1', position: 0, layout: 'title', html: '<h1 class="headline" onclick="x()">Hi</h1><script>bad()</script>', notes: '', slots: [] },
    { id: 's2', position: 1, layout: 'bullets', html: '<p>Two</p>', notes: 'n', slots: [] },
  ],
};

describe('deckMessage view', () => {
  it('is editable only on the stage and only when asked', () => {
    expect(deckMessage(deck, { mode: 'stage', index: 0, editable: true }).view.editable).toBe(true);
    expect(deckMessage(deck, { mode: 'thumb', index: 0, editable: true }).view.editable).toBe(false);
  });
});

describe('cleanInlineHtml', () => {
  it('keeps allowed inline tags and plain text', () => {
    expect(cleanInlineHtml('Hello <b>big</b> <em>world</em>')).toBe('Hello <b>big</b> <em>world</em>');
    expect(cleanInlineHtml('H<sub>2</sub>O')).toBe('H<sub>2</sub>O');
  });
  it('drops every attribute except class', () => {
    expect(cleanInlineHtml('<span class="hl" style="color:red" onclick="x()">a</span>')).toBe('<span class="hl">a</span>');
    expect(cleanInlineHtml('<b id="x" data-text="y">a</b>')).toBe('<b>a</b>');
  });
  it('turns div and p into line breaks', () => {
    expect(cleanInlineHtml('one<div>two</div><div>three</div>')).toBe('one<br>two<br>three');
    expect(cleanInlineHtml('<p>one</p><p>two</p>')).toBe('one<br>two');
    expect(cleanInlineHtml('a<div><br></div><div>b</div>')).toBe('a<br><br>b');
  });
  it('unwraps disallowed tags and drops scripts', () => {
    expect(cleanInlineHtml('<a href="http://x">link</a> and <h1>head</h1>')).toBe('link and head');
    expect(cleanInlineHtml('hi<script>bad()</script><style>x{}</style>')).toBe('hi');
  });
  it('trims trailing breaks and escapes text', () => {
    expect(cleanInlineHtml('end<br><br>')).toBe('end');
    expect(cleanInlineHtml('a<div><br></div>')).toBe('a');
    expect(cleanInlineHtml('R&amp;D &lt;3 &nbsp;x')).toBe('R&amp;D &lt;3  x');
  });
});

describe('deckMessage', () => {
  it('builds the posted payload and strips scripts and inline handlers', () => {
    const msg = deckMessage(deck, { mode: 'stage', index: 1 });
    expect(msg.type).toBe('conduit-deck');
    expect(msg.themeCss).toBe(deck.themeCss);
    expect(msg.view).toEqual({ mode: 'stage', index: 1, editable: false });
    expect(msg.slides.map((s) => [s.id, s.layout])).toEqual([
      ['s1', 'title'],
      ['s2', 'bullets'],
    ]);
    expect(msg.slides[0].html).not.toContain('<script');
    expect(msg.slides[0].html).not.toContain('onclick');
    expect(msg.slides[0].html).toContain('Hi');
    expect(Object.keys(msg.slides[0]).sort()).toEqual(['html', 'id', 'layout']);
  });
});

describe('DECK_FRAME_HTML', () => {
  it('is static: no deck content or theme appears in it', () => {
    for (const theme of STARTER_THEMES) expect(DECK_FRAME_HTML).not.toContain(theme.css.slice(0, 80));
    expect(DECK_FRAME_HTML).not.toContain('${');
    expect(DECK_FRAME_HTML).not.toContain('undefined');
    expect(DECK_FRAME_HTML).toContain('id="deck"');
    expect(DECK_FRAME_HTML).toContain('deck-viewport');
    expect(DECK_FRAME_HTML).toContain('deck-theme');
    expect(DECK_FRAME_HTML).toContain('conduit-deck-event');
  });

  it('auto-fits with the shared fit source and never posts fitted sizes', () => {
    const script = DECK_FRAME_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
    expect(script).toContain(DECK_FIT_SCRIPT);
    expect(script).toContain('conduitFit.fitSlide');
    expect(script).toContain('conduitFit.overflow');
    // A committed slot is read through cleanSlotHtml, never raw innerHTML.
    expect(script).toContain('var html = conduitFit.cleanSlotHtml(e.el);');
    expect(script).not.toMatch(/html: e\.el\.innerHTML|var html = e\.el\.innerHTML/);
  });

  it('is a script that parses', () => {
    const script = DECK_FRAME_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(100);
    // Constructing a Function parses without running it.
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('parseDeckEvent', () => {
  it('accepts ready and select, rejects the rest', () => {
    expect(parseDeckEvent({ type: 'conduit-deck-event', event: 'ready' })).toEqual({ event: 'ready' });
    expect(parseDeckEvent({ type: 'conduit-deck-event', event: 'select', slideId: 'a' })).toEqual({
      event: 'select',
      slideId: 'a',
    });
    expect(parseDeckEvent({ type: 'conduit-deck-event', event: 'select' })).toBeNull();
    expect(parseDeckEvent({ type: 'other', event: 'ready' })).toBeNull();
    expect(parseDeckEvent('x')).toBeNull();
  });

  it('accepts the editing, key and overflow events', () => {
    const e = (o: object) => parseDeckEvent({ type: 'conduit-deck-event', ...o });
    expect(e({ event: 'slot-select', slideId: 'a', index: 1, name: 'stat-2' })).toEqual({
      event: 'slot-select',
      slideId: 'a',
      index: 1,
      name: 'stat-2',
    });
    expect(e({ event: 'slot-edit', slideId: 'a', index: 0, name: 'h', html: 'x' })).toEqual({
      event: 'slot-edit',
      slideId: 'a',
      index: 0,
      name: 'h',
      html: 'x',
    });
    expect(e({ event: 'slot-edit', slideId: 'a', index: 0, name: 'h' })).toBeNull();
    expect(e({ event: 'slot-select', slideId: 'a', index: -1, name: 'h' })).toBeNull();
    expect(e({ event: 'key', key: 'Home' })).toEqual({ event: 'key', key: 'Home' });
    expect(e({ event: 'overflow', slides: [{ id: 'a', px: 140.4 }] })).toEqual({
      event: 'overflow',
      slides: [{ id: 'a', px: 140 }],
    });
    expect(e({ event: 'overflow', slides: [{ id: 'a' }] })).toBeNull();
  });
});

describe('starter themes', () => {
  const vocabulary = ['title', 'statement', 'bullets', 'stat-row', 'two-col', 'quote', 'section', 'image-left', 'chart'];
  const components = ['.kicker', '.headline', '.sub', '.body', 'ul.bullets', '.stat', '.quote', '.cite', '.col', '.footnote', '.accent'];
  const tokens = ['--bg', '--ink', '--ink-2', '--accent', '--surface', '--font-display', '--font-body', '--font-mono'];

  it('style every layout, component and token, and the contract names them all', () => {
    expect(STARTER_THEMES.map((t) => t.name)).toEqual(['ink', 'paper']);
    for (const theme of STARTER_THEMES) {
      for (const l of vocabulary) expect(theme.css, `${theme.name} ${l}`).toContain(`data-layout="${l}"`);
      for (const c of components) expect(theme.css, `${theme.name} ${c}`).toContain(c);
      for (const k of tokens) expect(theme.css, `${theme.name} ${k}`).toContain(`${k}:`);
    }
    for (const word of [...vocabulary, ...components.map((c) => c.replace('ul', '').replace(/^\./, '')), ...tokens]) {
      expect(THEME_CONTRACT).toContain(word);
    }
  });

  it('uses system fonts only and no external URLs', () => {
    for (const theme of STARTER_THEMES) {
      expect(theme.css).not.toMatch(/@import|url\(|https?:/);
    }
  });

  it('never clips at the top: centred and end-aligned layouts are safe', () => {
    for (const theme of STARTER_THEMES) {
      expect(theme.css).not.toMatch(/(justify|align)-content:\s*(center|flex-end)/);
      expect(theme.css).toContain('justify-content: safe center');
      expect(theme.css).toContain('.slide[data-layout="title"] { justify-content: safe flex-end;');
      expect(theme.css).toContain('.slide[data-layout="section"] { justify-content: safe flex-end;');
    }
  });

  it('places the image-left visual in its own column, in a box the theme owns', () => {
    for (const theme of STARTER_THEMES) {
      expect(theme.css).not.toContain('grid-row: 1 / span 12');
      const rule = /\.slide\[data-layout="image-left"\] > \.image \{([^}]*)\}/.exec(theme.css)?.[1] ?? '';
      expect(rule).toContain('position: absolute');
      expect(rule).toContain('left: 120px');
      expect(rule).toContain('width: 820px !important');
      expect(rule).toContain('height: auto !important');
      expect(rule).toContain('max-height: 840px !important');
      expect(theme.css).toContain('padding-left: 1036px');
    }
  });

  it('draws a chart full width in a theme-owned box, and other top-level svgs at their aspect ratio', () => {
    for (const theme of STARTER_THEMES) {
      const rule = /\.slide\[data-layout="chart"\] > figure \{([^}]*)\}/.exec(theme.css)?.[1] ?? '';
      expect(rule).toContain('width: 1680px !important');
      expect(rule).toContain('height: auto !important');
      expect(rule).toContain('max-height: 640px !important');
      expect(theme.css).toContain('.slide[data-layout="chart"] .headline { font-size: 80px; }');
      expect(theme.css).toContain('.slide > svg, .slide > figure > svg { width: 100%; height: auto; max-height: 600px;');
    }
    expect(THEME_CONTRACT).toContain(
      '- chart: .headline, one <svg> chart or diagram drawn full width (1680 x up to 640), optional .footnote.',
    );
  });

  it('keeps stat labels off spans inside the value, and the value inside its column', () => {
    for (const theme of STARTER_THEMES) {
      expect(theme.css).toContain('.slide .stat > span {');
      expect(theme.css).not.toMatch(/\.stat span/);
      expect(theme.css).toMatch(/\.slide \.stat \{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
    }
  });
});
