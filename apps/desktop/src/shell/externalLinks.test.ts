import { afterEach, describe, expect, it, vi } from 'vitest';
import { installExternalLinkHandler } from './externalLinks';

vi.mock('../ipc/client', () => ({ openExternalUrl: vi.fn(async () => undefined) }));

describe('installExternalLinkHandler', () => {
  let uninstall: (() => void) | null = null;
  afterEach(() => {
    uninstall?.();
    uninstall = null;
    document.body.innerHTML = '';
  });

  function link(href: string, inner = false) {
    document.body.innerHTML = `<p><a href="${href}" target="_blank">${inner ? '<b>story</b>' : 'story'}</a></p>`;
    return (inner ? document.querySelector('b') : document.querySelector('a')) as HTMLElement;
  }

  it('opens a web link in the system browser, from the link or text inside it', () => {
    const open = vi.fn(async () => undefined);
    uninstall = installExternalLinkHandler(document, open);
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link('https://news.ycombinator.com/item?id=1', true).dispatchEvent(event);
    expect(open).toHaveBeenCalledWith('https://news.ycombinator.com/item?id=1');
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves other schemes, handled clicks and right clicks alone', () => {
    const open = vi.fn(async () => undefined);
    uninstall = installExternalLinkHandler(document, open);
    link('mailto:a@example.com').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    link('javascript:alert(1)').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const a = link('https://example.com/');
    a.addEventListener('click', (e) => e.preventDefault());
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    link('https://example.com/').dispatchEvent(new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    expect(open).not.toHaveBeenCalled();
  });
});
