import { describe, expect, it } from 'vitest';
import { DECK_FRAME_HTML, cleanInlineHtml, deckMessage, parseDeckEvent } from './deckDocument';
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
  const vocabulary = ['title', 'statement', 'bullets', 'stat-row', 'two-col', 'quote', 'section', 'image-left'];
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
});
