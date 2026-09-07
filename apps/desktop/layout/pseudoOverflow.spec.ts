import { expect, test } from '@playwright/test';

/**
 * Does anything overflow under a longer language that does not overflow under
 * English? (Phase 4 of docs/plans/localization.md.)
 *
 * The plan's method is "screenshot every screen under `en` and `en-XA`, diff,
 * fix the clipping". This does the same comparison by measuring instead of by
 * eye, which makes it repeatable and lets it name the element.
 *
 * **It is a differential check, and that is the whole design.** Plenty of this
 * UI truncates on purpose — a conversation title, a model id, a file name —
 * and reporting those would bury the real findings under a hundred
 * by-design ones. An element that clips in *both* locales is working as
 * intended. An element that clips only under `en-XA` is length-sensitive, and
 * that is the bug German will find.
 *
 * The exception is the page itself: a horizontal scrollbar on the document is
 * never intended, in either locale, so that is asserted absolutely.
 *
 * What this cannot reach: `dev:web` runs the renderer without a Tauri backend,
 * so anything behind IPC — a populated conversation, the connector list, the
 * consent dialog — never renders. Those screens still need the real build.
 * This covers the shell, the empty states, and whatever opens without data.
 */

/** The shipped window size, and a plausible narrow resize. */
const VIEWPORTS = [
  { name: 'default 1360x900', width: 1360, height: 900 },
  { name: 'narrow 1024x720', width: 1024, height: 720 },
];

interface Clip {
  key: string;
  text: string;
  overflowBy: number;
}

/**
 * Every element whose own text is wider than the box that clips it.
 *
 * Keyed by a structural path rather than by text, so the same element can be
 * matched across two locales whose text differs by construction.
 */
async function clippedElements(page: import('@playwright/test').Page): Promise<Clip[]> {
  return page.evaluate(() => {
    /** A stable-ish path: tag + class list + sibling index, up three levels. */
    function key(el: Element): string {
      const parts: string[] = [];
      let node: Element | null = el;
      for (let depth = 0; node && depth < 3; depth += 1, node = node.parentElement) {
        const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/).join('.') : '';
        const index = node.parentElement
          ? [...node.parentElement.children].indexOf(node)
          : 0;
        parts.unshift(`${node.tagName.toLowerCase()}${cls ? `.${cls}` : ''}[${index}]`);
      }
      return parts.join(' > ');
    }

    const out: { key: string; text: string; overflowBy: number }[] = [];
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // Only boxes that actually hide the overflow can clip. `auto`/`scroll`
      // give the reader a way to see the rest.
      const clips = style.overflowX === 'hidden' || style.overflowX === 'clip';
      const scrolls = style.overflowX === 'auto' || style.overflowX === 'scroll';
      if (!clips && !scrolls) continue;
      const overflowBy = el.scrollWidth - el.clientWidth;
      if (overflowBy <= 1) continue; // sub-pixel rounding

      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent ?? '').trim())
        .join(' ')
        .trim();

      if (clips) {
        // Text clipped by its own box. Only interesting when the box holds the
        // text itself — a clipping wrapper around a child that fits is fine.
        if (!own) continue;
        out.push({ key: key(el), text: own.slice(0, 70), overflowBy });
        continue;
      }

      /* A pane that permits scrolling and is actually scrolling sideways.
       *
       * This is the case the first version of this check missed, and it is the
       * one that matters most: content does not have to be clipped to be a
       * bug. A centred block wider than its parent spills out with
       * `overflow: visible`, and the symptom appears on an ancestor — the
       * scroll container — as a horizontal scrollbar. Skipping `auto`/`scroll`
       * boxes because "they are meant to scroll" hid exactly that. They are
       * meant to scroll *vertically*; a column of prose sliding sideways is
       * never the intent. */
      const label = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
      out.push({ key: `${key(el)} (scrolls sideways)`, text: label.slice(0, 70), overflowBy });
    }
    return out;
  });
}

async function documentOverflow(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
}

async function open(page: import('@playwright/test').Page, locale: string) {
  await page.goto(`/?locale=${encodeURIComponent(locale)}`);
  // The shell resolves its language and catalog before first paint, but the
  // boot IPC calls still settle afterwards; wait for the composer, which is
  // the last thing the empty shell renders.
  await page.waitForSelector('.composer-textarea', { timeout: 30_000 });
}

/**
 * Walk every screen reachable without a backend, measuring each.
 *
 * Settings is walked pane by pane because it holds 285 of the app's extracted
 * strings — more than the rest of the UI put together — and each pane is a
 * separate layout that only renders when its nav item is selected.
 */
async function measureEveryScreen(
  page: import('@playwright/test').Page,
  locale: string,
): Promise<Map<string, Clip[]>> {
  const byScreen = new Map<string, Clip[]>();

  await open(page, locale);
  byScreen.set('shell', await clippedElements(page));

  /* The workspace chip's menu is the way in. Selected structurally rather than
   * by text, because the text is accented under `en-XA` — and it is the only
   * item in that menu carrying a keyboard hint, which makes `:has(kbd)` both
   * stable and language-independent. */
  await page.locator('.wschip').click();
  await page.locator('.menu-item:has(kbd)').click();
  await page.waitForSelector('.sheet[role="dialog"]', { timeout: 10_000 });

  const navItems = page.locator('.sheet-nav button');
  const paneCount = await navItems.count();
  expect(paneCount, 'the settings sheet rendered no navigation').toBeGreaterThan(5);

  for (let index = 0; index < paneCount; index += 1) {
    await navItems.nth(index).click();
    // The pane swaps synchronously; this settles the sheet's own transition.
    await page.waitForTimeout(100);
    byScreen.set(`settings/pane${index}`, await clippedElements(page));
  }

  return byScreen;
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('the page never scrolls horizontally, in either language', async ({ page }) => {
      for (const locale of ['en', 'en-XA']) {
        await open(page, locale);
        const overflow = await documentOverflow(page);
        expect(overflow, `the page scrolls horizontally under ${locale}`).toBeLessThanOrEqual(1);
      }
    });

    test('nothing clips under en-XA that does not already clip under en', async ({ page }) => {
      const baseline = await measureEveryScreen(page, 'en');
      const pseudo = await measureEveryScreen(page, 'en-XA');

      /* A walk that silently failed to navigate would compare two empty maps
       * and pass forever. The shell plus every settings pane is a dozen-odd
       * screens; anything less means the menu or the nav stopped working. */
      expect(
        pseudo.size,
        'the walk did not reach the settings panes',
      ).toBeGreaterThan(10);
      expect(pseudo.size).toBe(baseline.size);

      const regressions: string[] = [];
      for (const [screen, clips] of pseudo) {
        const seen = new Set((baseline.get(screen) ?? []).map((c) => c.key));
        for (const clip of clips) {
          if (seen.has(clip.key)) continue;
          regressions.push(
            `[${screen}] ${clip.key}\n      over by ${clip.overflowBy}px: ${JSON.stringify(clip.text)}`,
          );
        }
      }

      expect(
        regressions,
        'These clip only once the text gets longer, which is what German will do. ' +
          'Let the container grow, let the text wrap, or truncate it with a title.',
      ).toEqual([]);
    });
  });
}
