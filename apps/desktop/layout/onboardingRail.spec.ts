import { expect, test } from '@playwright/test';

/**
 * The first-run screen, measured.
 *
 * `pseudoOverflow.spec.ts` walks the shell and every settings pane and has
 * never once reached onboarding: it drives `pnpm dev:web`, where every IPC call
 * rejects, so `App` never sets `onboarding` and falls straight through to the
 * workspace. The screen was therefore unmeasured at exactly the moment it
 * became layout-sensitive — a two-column card with a rail holding five
 * translated step labels, a lede, and a media query that swaps the whole
 * geometry at 880px.
 *
 * `?route=onboarding` is the seam (`src/devRoute.ts`), dead code in a
 * production build.
 *
 * What this asserts is deliberately structural rather than pixel-exact. A
 * screenshot baseline across seven locales would fail on font fallback and
 * teach nobody anything; these are the three properties that actually break
 * when a translation runs long or a breakpoint is edited.
 */

/** The locales that stress this screen: the synthetic ~40% stressor, plus the
 *  two real languages whose step labels are longest ("Erscheinungsbild",
 *  "Privacidade"), plus one that is shorter than English so a rail sized only
 *  for German is still checked from the other side. */
const LOCALES = ['en', 'en-XA', 'de', 'pt-BR', 'ja'] as const;

const WIDE = { width: 1360, height: 900 };
/** Just below the 880px breakpoint, where the rail becomes a header band. */
const NARROW = { width: 820, height: 900 };

async function openOnboarding(page: import('@playwright/test').Page, locale: string) {
  await page.goto(`/?route=onboarding&locale=${encodeURIComponent(locale)}`);
  await page.waitForSelector('.onboarding-card--split', { timeout: 30_000 });
}

test.describe('the first-run card', () => {
  test.use({ viewport: WIDE });

  test('renders its rail and all five steps in every measured locale', async ({ page }) => {
    for (const locale of LOCALES) {
      await openOnboarding(page, locale);
      await expect(page.locator('.onboarding-rail'), `no rail under ${locale}`).toBeVisible();
      await expect(
        page.locator('.onboarding-step-dot'),
        `the stepper lost a step under ${locale}`,
      ).toHaveCount(5);
    }
  });

  test('never clips a step label in the rail', async ({ page }) => {
    /* The rail's width is the one genuinely fragile thing here: it is a
     * `minmax()` track sized for the longest label, and a longer translation or
     * a narrower floor silently truncates a step name. Measured per element
     * rather than by screenshot so a failure names the locale and the step. */
    for (const locale of LOCALES) {
      await openOnboarding(page, locale);
      const clipped = await page.locator('.onboarding-step-dot').evaluateAll((els) =>
        els
          .filter((el) => el.scrollWidth - el.clientWidth > 1)
          .map((el) => ({
            text: (el.textContent ?? '').trim(),
            by: el.scrollWidth - el.clientWidth,
          })),
      );
      expect(clipped, `a step label is clipped under ${locale}`).toEqual([]);
    }
  });

  test('does not scroll sideways, at either side of the breakpoint', async ({ page }) => {
    for (const viewport of [WIDE, NARROW]) {
      await page.setViewportSize(viewport);
      for (const locale of LOCALES) {
        await openOnboarding(page, locale);
        const overflow = await page.evaluate(() => {
          const el = document.scrollingElement ?? document.documentElement;
          return el.scrollWidth - el.clientWidth;
        });
        expect(
          overflow,
          `the page scrolls horizontally under ${locale} at ${viewport.width}px`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  test('keeps the card reachable from the top when it outgrows the window', async ({ page }) => {
    /* The regression this screen already had once: the card was centred in a
     * box it overflowed, so its heading sat above the top edge with no way to
     * scroll back — `overflow: auto` only ever scrolls forward from the origin.
     * `align-content: safe center` is what prevents it, and a short viewport is
     * the only way to prove the fallback engages. */
    await page.setViewportSize({ width: 1360, height: 420 });
    await openOnboarding(page, 'en-XA');
    const top = await page.locator('.onboarding-card--split').evaluate((el) => {
      const shell = el.closest('.onboarding-shell') as HTMLElement;
      return el.getBoundingClientRect().top - shell.getBoundingClientRect().top;
    });
    expect(top, 'the card starts above its scroll container and cannot be reached').toBeGreaterThanOrEqual(-1);
  });

  test('collapses to one column below the breakpoint', async ({ page }) => {
    // The rail and the body sit side by side above 880px and stack below it.
    // Asserted by geometry rather than by reading the media query back, so an
    // edit to either the query or the grid is caught.
    await page.setViewportSize(WIDE);
    await openOnboarding(page, 'de');
    const wide = await page.evaluate(() => {
      const rail = document.querySelector('.onboarding-rail')!.getBoundingClientRect();
      const body = document.querySelector('.onboarding-body')!.getBoundingClientRect();
      return body.left >= rail.right - 1;
    });
    expect(wide, 'the rail and body are not side by side on a wide window').toBe(true);

    await page.setViewportSize(NARROW);
    await openOnboarding(page, 'de');
    const narrow = await page.evaluate(() => {
      const rail = document.querySelector('.onboarding-rail')!.getBoundingClientRect();
      const body = document.querySelector('.onboarding-body')!.getBoundingClientRect();
      return body.top >= rail.bottom - 1;
    });
    expect(narrow, 'the card did not stack below the breakpoint').toBe(true);
  });
});
