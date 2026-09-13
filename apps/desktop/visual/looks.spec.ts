import { expect, test, type Page } from '@playwright/test';

/**
 * Visual baselines for the theming project (Phase 0 — `docs/theming/decisions.md`
 * P0.1). Screenshots `?route=gallery&section=<name>` (`src/dev/Gallery.tsx`)
 * for every palette x colour-scheme combination, plus a few bare routes, so the
 * coming CSS-to-tokens refactor can be checked against these under a
 * "zero visual change" contract.
 *
 * Local-only and opt-in (`pnpm test:visual`): baselines live in
 * `visual/__screenshots__/`, gitignored, because font rasterisation differs
 * across OSes — nobody's baseline is ever compared against anybody else's.
 * See `playwright.visual.config.ts` for the shared `toHaveScreenshot` defaults
 * (`animations: 'disabled'`, `maxDiffPixelRatio: 0.001`) this file also passes
 * explicitly, belt-and-suspenders, per the instructions this suite was built
 * against.
 */

/** Mirrors `PALETTE_KEY` in `src/shell/uiPrefs.ts` — `applyPalette(readPalette())`
 *  runs synchronously in `main.tsx` before first paint, straight off this key,
 *  so setting it via `addInitScript` (which runs before any page script) is
 *  enough to pin the palette for the whole test. */
const PALETTE_KEY = 'conduit:v9-palette';
const PALETTES = ['terra', 'orange-charcoal', 'orange-dark'] as const;
const MODES = ['dark', 'light'] as const;

/** Mirrors `SECTION_IDS` in `src/dev/Gallery.tsx`. Not imported from there —
 *  this spec runs against a built `dev:web` server, not the source tree, and
 *  the list is exactly the eight `data-gallery-section` values the task asks
 *  for, so a literal copy is the more honest dependency than a cross-boundary
 *  import into a component only reachable in DEV. */
const SECTIONS = [
  'primitives',
  'sidebar',
  'chat',
  'composer',
  'overlays',
  'settings',
  'document-panel',
  'status',
] as const;

/** Mirrors `GALLERY_NOW` in `src/dev/galleryFixtures.ts` (same reasoning as
 *  the literal `SECTIONS` copy above: this spec runs against a built
 *  `dev:web` server, not the source tree). Every fixture conversation's
 *  `updatedAt` sits at or before this instant, so freezing `Date.now()` to it
 *  (below) is what keeps the sidebar's day-bucket labels ("Today",
 *  "Yesterday") and relative-time strings from drifting as real wall-clock
 *  time moves past the fixture dates — without this, a baseline taken today
 *  stops matching a re-run next month for a reason that has nothing to do
 *  with a real visual change. */
const FIXED_NOW = '2026-09-13T12:00:00Z';

const VIEWPORT = { width: 1440, height: 900 };

const SCREENSHOT_OPTS = {
  fullPage: true,
  animations: 'disabled',
  maxDiffPixelRatio: 0.001,
} as const;

/**
 * Freeze `Date.now()` / `new Date()` (no-arg) to `FIXED_NOW`, leaving
 * `setTimeout`/`setInterval`/`requestAnimationFrame` completely real.
 *
 * Deliberately a plain `Date` shim rather than Playwright's `page.clock` fake
 * timers: `clock.install()` also fakes `requestAnimationFrame`, and `settle()`
 * below waits for the mermaid diagram to render with `page.waitForFunction`'s
 * default `raf` polling — faking that would either hang the wait for its full
 * 15s timeout or require driving the fake clock forward by hand. A bare
 * `Date` override needs neither: mermaid, KaTeX and React's own scheduling
 * all keep running on real timers, and the one thing that changes is what
 * `Date.now()` reports.
 *
 * This is also what pins `AssistantMessage`'s live "Xs" elapsed counter
 * (`useLiveElapsed`) to 0 on the streaming fixture: it seeds `startRef` from
 * `Date.now()` and re-reads `Date.now()` on each real `setInterval` tick, so
 * with both reads returning the same frozen instant the difference is always
 * zero — no need to special-case that component from the test side.
 */
function installFixedClock(page: Page): Promise<void> {
  return page.addInitScript((iso) => {
    const RealDate = Date;
    const fixedMs = new RealDate(iso).getTime();
    class FixedDate extends RealDate {
      constructor(...args: ConstructorParameters<typeof Date>) {
        if (args.length === 0) {
          super(fixedMs);
        } else {
          // @ts-expect-error — spreading a tuple into the real Date constructor
          super(...args);
        }
      }
      static now() {
        return fixedMs;
      }
    }
    // @ts-expect-error — intentionally replacing the global constructor
    window.Date = FixedDate;
  }, FIXED_NOW);
}

/**
 * Pin `data-theme` to `mode`, self-healing via a `MutationObserver` installed
 * before any page script runs (`addInitScript`) — so the attribute is already
 * settled at the right value long before anything reads it, rather than
 * corrected after the fact.
 *
 * `dev:web` has no Tauri backend, so `getSettings()` in `App`'s boot effect
 * always rejects — `AppSettings.theme` never leaves its hardcoded `'dark'`
 * default (`App.tsx`'s `defaultSettings`), and that effect writes
 * `data-theme="dark"` to `<html>` exactly once, at mount, ignoring
 * `prefers-color-scheme` entirely (confirmed by reading `theme.ts` and
 * `App.tsx`'s boot path, exactly as this file's task description asked to
 * verify).
 *
 * The first approach here forced the attribute *after* the app had mounted,
 * which reliably works for everything except the one fixture with a mermaid
 * diagram: `MermaidBlock` reads `data-theme` for its own diagram colours at
 * first render and redraws through a `MutationObserver` when the attribute
 * changes later, so a post-mount force reliably triggers a second render on
 * top of the first. `mermaid.initialize()` mutates shared module-level state,
 * and calling it (plus `.render()`) twice in quick succession — once for the
 * app's own write, once for this test's override — occasionally painted the
 * diagram with the wrong (error-red) node styling, independent of which
 * `data-theme` value either render actually used: a mermaid.js race, not a
 * theme-application bug in this app.
 *
 * Self-healing from before the app's own script ever runs sidesteps the race
 * instead of chasing it. `App`'s effect still writes `data-theme="dark"`
 * once, but this observer corrects it back on the same microtask — many
 * milliseconds before the lazily-loaded `Gallery` chunk (a network-speed
 * fetch) has even started, let alone mounted `MermaidBlock`. By the time the
 * diagram reads `data-theme` for the first (and, on a normal page load, only)
 * time, the attribute has already been stable at the right value for the
 * whole page load — no redraw, no race.
 */
async function pinTheme(page: Page, mode: 'dark' | 'light'): Promise<void> {
  await page.addInitScript((m) => {
    const root = document.documentElement;
    const apply = () => {
      if (root.getAttribute('data-theme') !== m) root.setAttribute('data-theme', m);
    };
    apply();
    new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  }, mode);
}

/**
 * Pin the palette (localStorage, read pre-paint), the theme (`pinTheme`), the
 * frozen clock, and the OS colour-scheme + reduced-motion media query the
 * app's own `resolveTheme('system')` / `prefers-reduced-motion` CSS both key
 * off, before any navigation.
 */
async function preparePage(page: Page, palette: string, mode: 'dark' | 'light') {
  await page.addInitScript(
    ([key, value]) => {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* storage may be unavailable in some contexts; the app degrades fine */
      }
    },
    [PALETTE_KEY, palette] as const,
  );
  await pinTheme(page, mode);
  await installFixedClock(page);
  await page.emulateMedia({ colorScheme: mode, reducedMotion: 'reduce' });
  await page.setViewportSize(VIEWPORT);
}

/**
 * Let the page settle before a pixel comparison: web fonts loaded, and — when
 * `mermaid` is set — the one mermaid diagram in the fixtures
 * (`GALLERY_ASSISTANT_MARKDOWN`, `galleryFixtures.ts`) painted and decoded.
 *
 * `pinTheme` (see its own comment) keeps `data-theme` stable for the whole
 * page load, so — unlike an earlier version of this file — `MermaidBlock`
 * never redraws here: it renders once, under the right theme from the start.
 * This just waits for that one render to land (`.md-mermaid-img` or, if the
 * source ever fails to parse, `.md-render-error`) and, for an image, for the
 * browser to finish decoding it before the screenshot.
 */
async function settle(page: Page, { mermaid = false }: { mermaid?: boolean } = {}) {
  // The overlays section's `CommandPalette` autofocuses its search input on
  // open (a real `requestAnimationFrame(() => inputRef.current?.focus())` in
  // `CommandPalette.tsx`), and a focused text input blinks its native caret —
  // browser chrome, not a CSS animation, so `animations: 'disabled'` above
  // never touches it. Whichever phase of the blink happens to land on the
  // capture frame is genuine randomness, not a rendering difference, and it
  // reproduced as an intermittent ~1-in-10 diff of a few thousand pixels
  // confined to the search box before this was found. Killing the caret's
  // colour is the standard fix for exactly this in screenshot testing: it
  // leaves focus rings and everything else about the "focused" look alone.
  await page.addStyleTag({
    content: 'textarea, input, [contenteditable] { caret-color: transparent !important; }',
  });
  // `document.fonts.ready` alone raced the Orange Charcoal / Orange Dark
  // palettes' one CSS difference that matters here: they override
  // `--font-prose` to Source Serif 4 (tokens.css), which — like every face in
  // this app — loads with `font-display: swap`, so the browser does not even
  // start fetching it until something on the page actually lays out text in
  // it. `fonts.ready` resolves against whatever is *already pending* at the
  // moment it is read, so reading it before that layout has happened resolves
  // immediately, against nothing, and the chat section's markdown prose (the
  // only fixture with enough of it to matter) gets one frame in the fallback
  // face — invisible to a human, a real pixel diff to `toHaveScreenshot`.
  // Forcing the specific faces this app ships in that font, then re-checking
  // `ready`, removes the race instead of praying `waitForTimeout` outruns it.
  await page.evaluate(async () => {
    const specs = [
      '400 16px "Source Serif 4"',
      'italic 400 16px "Source Serif 4"',
      '700 16px "Source Serif 4"',
      'italic 700 16px "Source Serif 4"',
    ];
    await Promise.all(specs.map((spec) => document.fonts.load(spec).catch(() => [])));
    await document.fonts.ready;
  });
  if (mermaid) {
    await page
      .waitForFunction(
        () =>
          document.querySelector('.md-mermaid-img') != null ||
          document.querySelector('.md-render-error') != null,
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => {
        /* a render that never lands still gets screenshotted — the diff
         * against the baseline is the signal, not a hard failure here */
      });
    // `.md-mermaid-img`'s `src` appearing only proves the blob URL exists,
    // not that the browser has finished decoding and painting it — under
    // load (a busy machine, another process competing for the CPU) those two
    // can be far enough apart to catch the image mid-decode, which is
    // exactly the kind of one-run-in-many flake a pixel diff cannot
    // distinguish from a real regression. `HTMLImageElement.decode()`
    // resolves only once the bitmap is fully decoded and ready to paint.
    await page
      .evaluate(async () => {
        const img = document.querySelector('.md-mermaid-img');
        if (img instanceof HTMLImageElement && typeof img.decode === 'function') {
          await img.decode();
        }
      })
      .catch(() => {
        /* no image to decode (render failed into .md-render-error instead) */
      });
  }
  // KaTeX renders synchronously (`katex.renderToString`); nothing further to
  // await for it. This last beat is for layout/paint after the work above.
  await page.waitForTimeout(100);
}

for (const palette of PALETTES) {
  for (const mode of MODES) {
    test.describe(`${palette} / ${mode}`, () => {
      test.beforeEach(async ({ page }) => {
        await preparePage(page, palette, mode);
      });

      for (const section of SECTIONS) {
        test(`gallery section — ${section}`, async ({ page }) => {
          await page.goto(`/?route=gallery&section=${section}`);
          await page.waitForSelector(`[data-gallery-section="${section}"]`);
          await settle(page, { mermaid: section === 'chat' });
          await expect(page).toHaveScreenshot(`${palette}-${mode}-${section}.png`, SCREENSHOT_OPTS);
        });
      }

      test('bare workspace', async ({ page }) => {
        await page.goto('/');
        await page.waitForSelector('#app');
        await settle(page);
        await expect(page).toHaveScreenshot(`${palette}-${mode}-workspace.png`, SCREENSHOT_OPTS);
      });

      test('?route=artifacts', async ({ page }) => {
        await page.goto('/?route=artifacts');
        await page.waitForSelector('.doc-panel');
        await settle(page);
        await expect(page).toHaveScreenshot(`${palette}-${mode}-artifacts.png`, SCREENSHOT_OPTS);
      });

      test('?route=onboarding', async ({ page }) => {
        await page.goto('/?route=onboarding');
        // Same selector `layout/onboardingRail.spec.ts` waits on.
        await page.waitForSelector('.onboarding-card--split');
        await settle(page);
        await expect(page).toHaveScreenshot(`${palette}-${mode}-onboarding.png`, SCREENSHOT_OPTS);
      });
    });
  }
}
