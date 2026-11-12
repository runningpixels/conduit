/// Web links in the app's own pages open in the system browser.
///
/// The webview drops `target="_blank"` navigations, so a link in a chat reply,
/// a source list or a search result did nothing when clicked. The shell
/// plugin's injected script tries to catch those on <body>, but it calls
/// `shell.open`, which the app's capabilities don't grant, so it failed
/// silently (and marked the click handled). This listener sits on React's root
/// element, after React's own listener there and before <body>: a component
/// that handled the click (`defaultPrevented`) wins, and every other web link
/// goes to `open_external_url`, which checks it again in Rust. Links inside
/// artifact frames are a different document and keep their own consent path.

import { isHttpOrHttpsUrl } from '../artifacts/externalUrl';
import { openExternalUrl } from '../ipc/client';

/// The http(s) URL a click on `target` should open, or null to leave it alone.
export function externalLinkFor(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  const href = anchor.getAttribute('href') ?? '';
  return isHttpOrHttpsUrl(href) ? href : null;
}

export function installExternalLinkHandler(
  root: EventTarget = document,
  open: (url: string) => Promise<void> = openExternalUrl,
): () => void {
  const onClick = (event: Event) => {
    const e = event as MouseEvent;
    // Left and middle button only; a component that handled the click wins.
    if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return;
    const url = externalLinkFor(e.target);
    if (!url) return;
    e.preventDefault();
    open(url).catch((err: unknown) => console.warn('could not open link', err));
  };
  root.addEventListener('click', onClick);
  root.addEventListener('auxclick', onClick);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('auxclick', onClick);
  };
}
