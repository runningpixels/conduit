// Runs the frame's own runtime script under jsdom and drives it with the
// messages the app posts, to check what ends up in the frame's DOM.
import { afterEach, describe, expect, it } from 'vitest';
import { DECK_FRAME_HTML, deckMessage } from './deckDocument';

function bootRuntime() {
  const script = /<script>([\s\S]*)<\/script>/.exec(DECK_FRAME_HTML)?.[1];
  if (!script) throw new Error('no runtime script in DECK_FRAME_HTML');
  document.body.innerHTML = DECK_FRAME_HTML.replace(/<script>[\s\S]*<\/script>/, '');
  // eslint-disable-next-line no-new-func
  new Function(script)();
  return (message: unknown) => window.dispatchEvent(new MessageEvent('message', { data: message, source: window }));
}

const slide = (id: string, position: number, html: string) => ({ id, position, layout: 'statement', html, notes: '', slots: [] });

afterEach(() => {
  document.body.innerHTML = '';
});

describe('deck frame runtime', () => {
  it('keeps exactly one node per slide when a slide is rewritten', () => {
    const post = bootRuntime();
    const view = { mode: 'stage' as const, index: 0, editable: false };
    post(deckMessage({ themeCss: '', slides: [slide('a', 0, '<h1>Old</h1>'), slide('b', 1, '<p>B</p>')] }, view));
    post(deckMessage({ themeCss: '', slides: [slide('a', 0, '<h1>New</h1>'), slide('b', 1, '<p>B</p>')] }, view));

    const sections = [...document.querySelectorAll('#deck > section')];
    expect(sections.map((s) => s.getAttribute('data-slide'))).toEqual(['a', 'b']);
    expect(document.querySelector('#deck')?.textContent).not.toContain('Old');
    expect(sections[0].classList.contains('is-current')).toBe(true);
  });

  it('removes deleted slides and follows a reorder', () => {
    const post = bootRuntime();
    const view = { mode: 'stage' as const, index: 0, editable: false };
    post(deckMessage({ themeCss: '', slides: [slide('a', 0, 'A'), slide('b', 1, 'B'), slide('c', 2, 'C')] }, view));
    post(deckMessage({ themeCss: '', slides: [slide('c', 0, 'C'), slide('a', 1, 'A')] }, view));

    const ids = [...document.querySelectorAll('#deck > section')].map((s) => s.getAttribute('data-slide'));
    expect(ids).toEqual(['c', 'a']);
  });
});
