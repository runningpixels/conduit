import { expect, test, type Page } from '@playwright/test';

/**
 * Side columns on a narrow window.
 *
 * At or below 900px both side columns are force-collapsed, and at or below
 * 1100px the document panel is. Before overlays, that was a dead end: the
 * toggles flipped a collapse attribute the forced collapse then ignored, so no
 * conversation and no artifact could be reached by pointer. These drive the
 * real shell in `dev:web` to prove each column can be brought back — and put
 * away again — without disturbing the thread or the saved desktop layout.
 */

const NARROW = { width: 860, height: 800 };
const PANEL_ONLY = { width: 1000, height: 800 };
const WIDE = { width: 1440, height: 900 };

async function openShell(page: Page) {
  await page.goto('/?locale=en');
  await page.waitForSelector('.main-head', { timeout: 30_000 });
  await page.evaluate(() => {
    localStorage.removeItem('conduit:v5-sidebar');
    localStorage.removeItem('conduit:v5-doc-panel');
  });
  await page.goto('/?locale=en');
  await page.waitForSelector('.main-head', { timeout: 30_000 });
  // dev:web has no IPC, so boot ends in a "Failed to load desktop state" toast.
  // Wait for it: that is boot settling, and interacting before then races the
  // state it resets. It also sits over the title strip's right end, so dismiss it.
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  await dismiss.first().waitFor({ timeout: 15_000 });
  for (const button of await dismiss.all()) {
    await button.click().catch(() => {});
  }
}

function overlayAttr(page: Page, id: 'sidebar' | 'panel') {
  return page.locator('html').getAttribute(`data-${id}-overlay`);
}

async function box(page: Page, selector: string) {
  const b = await page.locator(selector).boundingBox();
  if (!b) throw new Error(`${selector} has no box`);
  return b;
}

test.describe('the sidebar below the narrow breakpoint', () => {
  test.use({ viewport: NARROW });
  test.beforeEach(async ({ page }) => openShell(page));

  test('is hidden, out of the tab order, with its actions in the title strip', async ({ page }) => {
    await expect(page.locator('.body > .sidebar')).toHaveCSS('visibility', 'hidden');
    await expect(page.getByRole('button', { name: 'Open sidebar' })).toBeVisible();
    await expect(page.locator('.head-nav').getByRole('button', { name: 'New chat' })).toBeVisible();
    await expect(page.locator('.head-nav').getByRole('button', { name: 'Search' })).toBeVisible();
  });

  test('opens as an overlay over the thread, without resizing it', async ({ page }) => {
    const threadBefore = await box(page, '.center');
    const toggle = page.getByRole('button', { name: 'Open sidebar' });
    await toggle.click();

    expect(await overlayAttr(page, 'sidebar')).toBe('open');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const sidebar = page.locator('.body > .sidebar');
    await expect(sidebar).toBeVisible();
    // Measured once the slide-in has finished.
    await expect.poll(async () => Math.round((await box(page, '.body > .sidebar')).x)).toBe(0);
    expect((await box(page, '.body > .sidebar')).width).toBeGreaterThanOrEqual(220);
    await expect(page.locator('.overlay-scrim')).toBeVisible();
    // Keyboard focus went in with it.
    expect(await sidebar.evaluate((el) => el.contains(document.activeElement))).toBe(true);

    const threadAfter = await box(page, '.center');
    expect(threadAfter.width).toBe(threadBefore.width);
  });

  test('closes on Escape and hands focus back to the toggle', async ({ page }) => {
    const toggle = page.getByRole('button', { name: 'Open sidebar' });
    await toggle.click();
    await page.keyboard.press('Escape');
    expect(await overlayAttr(page, 'sidebar')).toBeNull();
    await expect(toggle).toBeFocused();
  });

  test('closes on a click on the scrim', async ({ page }) => {
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    // Click the scrim well clear of the overlay.
    await page.mouse.click(NARROW.width - 40, NARROW.height / 2);
    expect(await overlayAttr(page, 'sidebar')).toBeNull();
  });

  test('toggles from the keyboard shortcut', async ({ page }) => {
    await page.keyboard.press('Control+Backslash');
    expect(await overlayAttr(page, 'sidebar')).toBe('open');
    await page.keyboard.press('Control+Backslash');
    expect(await overlayAttr(page, 'sidebar')).toBeNull();
  });

  test('traps Tab inside the overlay', async ({ page }) => {
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    const sidebar = page.locator('.body > .sidebar');
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      const where = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement | null;
        return `${a?.tagName}.${a?.className} "${(a?.getAttribute('aria-label') ?? a?.textContent ?? '').slice(0, 30)}"`;
      });
      expect(await sidebar.evaluate((el) => el.contains(document.activeElement)), `Tab #${i + 1} escaped to ${where}`).toBe(true);
    }
  });

  test('shows one overlay at a time', async ({ page }) => {
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await page.keyboard.press('Control+KeyJ');
    expect(await overlayAttr(page, 'panel')).toBe('open');
    expect(await overlayAttr(page, 'sidebar')).toBeNull();
  });

  test('does not rewrite the saved desktop layout', async ({ page }) => {
    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await page.keyboard.press('Escape');
    await page.setViewportSize(WIDE);
    await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'open');
    await expect(page.locator('.body > .sidebar')).toBeVisible();
  });
});

test.describe('the document panel below its breakpoint', () => {
  test.use({ viewport: PANEL_ONLY });
  test.beforeEach(async ({ page }) => openShell(page));

  test('opens from its toggle as an overlay, and says so', async ({ page }) => {
    const toggle = page.locator('.panel-toggle');
    await expect(page.locator('.body > .doc-panel')).toHaveCSS('visibility', 'hidden');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await toggle.click();
    expect(await overlayAttr(page, 'panel')).toBe('open');
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const panel = await box(page, '.body > .doc-panel');
    expect(Math.round(panel.x + panel.width)).toBeGreaterThan(PANEL_ONLY.width - 20);
  });

  test('is dropped when the window grows wide enough for the column', async ({ page }) => {
    await page.locator('.panel-toggle').click();
    expect(await overlayAttr(page, 'panel')).toBe('open');
    await page.setViewportSize(WIDE);
    await expect.poll(() => overlayAttr(page, 'panel')).toBeNull();
    await expect(page.locator('.overlay-scrim')).toBeHidden();
    await expect(page.locator('.body > .doc-panel')).toBeVisible();
  });
});
