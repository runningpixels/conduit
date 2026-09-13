import { expect, test, type Page } from '@playwright/test';

/**
 * The artifact panel opens when there is something to put in it.
 *
 * A new chat used to open onto a 420px "Artifacts live here" card — about a
 * third of a 1440px window, empty. `dev:web` has no backend, so it can only
 * ever show a chat with no artifacts, which is exactly the case this measures:
 * the panel stays shut, the thread gets the room, and the toggle still opens
 * the empty panel for anyone who wants it.
 */

const WIDE = { width: 1440, height: 900 };

async function openShell(page: Page) {
  await page.goto('/?locale=en');
  await page.waitForSelector('.main-head', { timeout: 30_000 });
  await page.evaluate(() => {
    localStorage.removeItem('conduit:v5-doc-panel');
    localStorage.removeItem('conduit:v5-sidebar');
  });
  await page.goto('/?locale=en');
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  await dismiss.first().waitFor({ timeout: 15_000 });
  for (const button of await dismiss.all()) {
    await button.click().catch(() => {});
  }
}

test.describe('the artifact panel on an empty chat', () => {
  test.use({ viewport: WIDE });
  test.beforeEach(async ({ page }) => openShell(page));

  test('stays shut and leaves the room to the thread', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-panel', 'closed');
    await expect(page.locator('.body > .doc-panel')).toHaveCSS('visibility', 'hidden');
    await expect(page.locator('.panel-toggle')).toHaveAttribute('aria-pressed', 'false');
    const thread = await page.locator('.center').boundingBox();
    const sidebar = await page.locator('.body > .sidebar').boundingBox();
    // Everything but the sidebar and the 12px handle track.
    expect(Math.round(thread!.width)).toBe(WIDE.width - Math.round(sidebar!.width) - 12);
  });

  test('still opens from its toggle, without changing the saved preference', async ({ page }) => {
    await page.locator('.panel-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-panel', 'open');
    await expect(page.getByRole('heading', { name: 'Artifacts live here' })).toBeVisible();
    await expect(page.locator('.panel-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('conduit:v5-doc-panel'))).toBe('open');

    // And shuts again from the same toggle, which is now an ordinary collapse.
    await page.locator('.panel-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('data-panel', 'closed');
    expect(await page.evaluate(() => localStorage.getItem('conduit:v5-doc-panel'))).toBe('closed');
  });
});
