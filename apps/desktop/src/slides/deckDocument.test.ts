import { describe, expect, it } from 'vitest';
import { DECK_FRAME_HTML, deckMessage, parseDeckEvent } from './deckDocument';
import { STARTER_THEMES, THEME_CONTRACT } from './themes';

const deck = {
  themeCss: '.slide{color:red}',
  slides: [
    { id: 's1', position: 0, layout: 'title', html: '<h1 class="headline" onclick="x()">Hi</h1><script>bad()</script>', notes: '' },
    { id: 's2', position: 1, layout: 'bullets', html: '<p>Two</p>', notes: 'n' },
  ],
};

describe('deckMessage', () => {
  it('builds the posted payload and strips scripts and inline handlers', () => {
    const msg = deckMessage(deck, { mode: 'stage', index: 1 });
    expect(msg.type).toBe('conduit-deck');
    expect(msg.themeCss).toBe(deck.themeCss);
    expect(msg.view).toEqual({ mode: 'stage', index: 1 });
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
