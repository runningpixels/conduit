/// "Delete cookies and site data" for pages with their own origin (ADR-007).
///
/// A page with full web access runs on its own origin on Rust's loopback page
/// server (`page_server`), where it can keep cookies, local storage, IndexedDB
/// and caches like any website. Nothing in the app can reach another origin's
/// storage directly, so clearing happens on the page's own origin: Rust mints
/// a one-shot URL (`/<token>/__clear`) that answers with `Clear-Site-Data`
/// and a script that empties the same storage by hand, then posts
/// `conduit:page-data-cleared` to the app. This loads that URL in a hidden
/// frame and waits for the message.
///
/// Used by "Clear site data" (a page's menu), "Clear data for all pages"
/// (Settings), and the sweep that clears pages deleted or no longer given full
/// web access.

import {
  clearPageCookies,
  forgetPageOrigin,
  listPageOrigins,
  mintPageClear,
  type PagePrincipal,
} from '../ipc/client';
import { invokeCommand } from '../ipc/errors';

/** What the clear page posts once done (Rust `CLEARED_MESSAGE_TYPE`). */
export const PAGE_DATA_CLEARED_MESSAGE_TYPE = 'conduit:page-data-cleared';
/** How long to wait for the clear page before giving up. */
export const PAGE_DATA_CLEAR_TIMEOUT_MS = 5000;

/**
 * Clear everything `principal`'s origin stores. True when the page reported
 * back (or no page has an origin at all: the page server isn't running);
 * false when it didn't within the timeout or the URL couldn't be minted.
 */
export async function clearPageSiteData(
  principal: PagePrincipal,
  timeoutMs = PAGE_DATA_CLEAR_TIMEOUT_MS,
): Promise<boolean> {
  let clear;
  try {
    clear = await mintPageClear(principal);
  } catch {
    return false;
  }
  if (!clear) return true;
  const { token, url, origin } = clear;
  const frame = document.createElement('iframe');
  // Same flags as the page's own frame on its origin: scripts and its origin,
  // nothing else.
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
  frame.src = url;
  let onMessage: ((event: MessageEvent) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = new Promise<boolean>((resolve) => {
    onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== origin) return;
      const data = event.data as { type?: unknown } | null;
      if (data && typeof data === 'object' && data.type === PAGE_DATA_CLEARED_MESSAGE_TYPE) resolve(true);
    };
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  window.addEventListener('message', onMessage!);
  document.body.appendChild(frame);
  const ok = await done;
  if (timer) clearTimeout(timer);
  window.removeEventListener('message', onMessage!);
  frame.remove();
  // Used up on load; dropped here too in case it never loaded.
  void invokeCommand('drop_artifact_frame', { token }).catch(() => {});
  if (ok) await forgetPageOrigin(principal).catch(() => {});
  return ok;
}

export interface ClearAllResult {
  cleared: number;
  failed: number;
}

/** Clear every page that has, or had, its own origin, then the cookies of
 *  what pages embed (every cookie in the webview but the app's own). */
export async function clearAllPageSiteData(): Promise<ClearAllResult> {
  const origins = await listPageOrigins();
  const result: ClearAllResult = { cleared: 0, failed: 0 };
  for (const { principal } of origins) {
    if (await clearPageSiteData(principal)) result.cleared += 1;
    else result.failed += 1;
  }
  try {
    await clearPageCookies();
  } catch {
    result.failed += 1;
  }
  return result;
}

let sweeping: Promise<void> | null = null;

/** Clear pages that were deleted or no longer have full web access. One
 *  sweep at a time; a call during a sweep shares it. `everyPage` overrides
 *  the Settings switch as Rust last saw it (Settings saves after a delay). */
export function sweepPageSiteData(options: { everyPage?: boolean } = {}): Promise<void> {
  sweeping ??= (async () => {
    try {
      const origins = await listPageOrigins();
      for (const page of origins) {
        const full = options.everyPage === undefined ? page.fullAccess : page.granted || options.everyPage;
        if (!page.exists || !full) await clearPageSiteData(page.principal);
      }
    } catch {
      /* best effort: the next sweep or "Clear data for all pages" retries */
    } finally {
      sweeping = null;
    }
  })();
  return sweeping;
}
