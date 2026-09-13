import { expect, test, type Page } from '@playwright/test';

/**
 * Room to work in the artifact panel.
 *
 * Measured against real content through `?route=artifacts` (devRoute.ts), which
 * puts an HTML dashboard, a Markdown report with a wide table and a code file
 * in the panel — dev:web otherwise has nothing to show there. Each assertion
 * pins something the design iterations in docs/plans/artifact-panel-width.md
 * found broken: a 560px ceiling that clipped the dashboard, tab names squeezed
 * to nothing, prose at 190 characters a line once the panel was wide, and a
 * status line that shattered in a narrow thread.
 */

const WIDE = { width: 1440, height: 900 };

async function openArtifacts(page: Page, layout: Record<string, number> = { sidebarW: 280, panelW: 420 }) {
  await page.goto('/?route=artifacts&locale=en');
  await page.waitForSelector('.main-head', { timeout: 30_000 });
  await page.evaluate((stored) => {
    localStorage.setItem('conduit:v5-layout', JSON.stringify(stored));
    localStorage.setItem('conduit:v5-sidebar', 'open');
    localStorage.setItem('conduit:v5-doc-panel', 'open');
  }, layout);
  await page.goto('/?route=artifacts&locale=en');
  await page.waitForSelector('.artifact-file-tab', { timeout: 30_000 });
  const dismiss = page.getByRole('button', { name: 'Dismiss' });
  await dismiss.first().waitFor({ timeout: 15_000 });
  for (const button of await dismiss.all()) await button.click().catch(() => {});
}

async function width(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
}

/** A width once the column animation has finished: two readings a frame apart agree. */
async function settledWidth(page: Page, selector: string): Promise<number> {
  let previous = -1;
  for (let i = 0; i < 40; i++) {
    const current = await width(page, selector);
    if (current === previous) return current;
    previous = current;
    await page.waitForTimeout(60);
  }
  return previous;
}

async function openTab(page: Page, name: string) {
  await page.locator('.artifact-file-tab .tab-select', { hasText: name }).click();
}

test.describe('the artifact panel', () => {
  test.use({ viewport: WIDE });

  test('shows every open artifact by name', async ({ page }) => {
    await openArtifacts(page);
    const names = await page.locator('.artifact-file-tab .tab-name').evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().width)),
    );
    expect(names).toHaveLength(3);
    for (const w of names) expect(w).toBeGreaterThan(40);
  });

  test('drags past the old 560px ceiling, as far as the thread floor allows', async ({ page }) => {
    await openArtifacts(page);
    await page.locator('#columnResize').focus();
    await page.keyboard.press('End');
    // 1440 − the 280px sidebar − the 12px handle − the 400px thread floor.
    await expect.poll(() => width(page, '.body > .doc-panel')).toBeGreaterThan(700);
    expect(await width(page, '.center')).toBeGreaterThanOrEqual(400);
  });

  test('expands: the sidebar steps aside, the panel takes the room, the layout comes back', async ({ page }) => {
    await openArtifacts(page);
    const before = { panel: await settledWidth(page, '.body > .doc-panel'), sidebar: await settledWidth(page, '.body > .sidebar') };

    await page.getByRole('button', { name: 'Expand artifact' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-panel-expanded', 'true');
    await expect.poll(() => width(page, '.body > .doc-panel')).toBeGreaterThan(1000);
    await expect(page.locator('.body > .sidebar')).toHaveCSS('visibility', 'hidden');
    // The sidebar's actions stay reachable, in the title strip.
    await expect(page.locator('.head-nav').getByRole('button', { name: 'New chat' })).toBeVisible();
    // The dashboard lays out as a page, not a phone.
    expect(await width(page, '.doc-panel iframe')).toBeGreaterThan(1000);
    // Nothing about the saved layout changed.
    expect(await page.evaluate(() => localStorage.getItem('conduit:v5-layout'))).toBe(
      JSON.stringify({ sidebarW: 280, panelW: 420 }),
    );

    await page.getByRole('button', { name: 'Restore layout' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-panel-expanded', 'true');
    await expect.poll(() => width(page, '.body > .doc-panel')).toBe(before.panel);
    await expect.poll(() => width(page, '.body > .sidebar')).toBe(before.sidebar);
  });

  test('expands and restores from the keyboard', async ({ page }) => {
    await openArtifacts(page);
    await page.locator('body').click({ position: { x: 700, y: 300 } });
    await page.keyboard.press('Control+Shift+E');
    await expect(page.locator('html')).toHaveAttribute('data-panel-expanded', 'true');
    await page.keyboard.press('Control+Shift+E');
    await expect(page.locator('html')).not.toHaveAttribute('data-panel-expanded', 'true');
  });

  test('restores the layout when the sidebar is asked for', async ({ page }) => {
    await openArtifacts(page);
    await page.getByRole('button', { name: 'Expand artifact' }).click();
    await page.locator('.head-nav').getByRole('button', { name: 'Open sidebar' }).click();
    await expect(page.locator('html')).not.toHaveAttribute('data-panel-expanded', 'true');
    await expect(page.locator('.body > .sidebar')).toBeVisible();
  });

  test('reads a wide document at a measure, and lets its table use the room', async ({ page }) => {
    await openArtifacts(page);
    await page.getByRole('button', { name: 'Expand artifact' }).click();
    await openTab(page, 'q3-launch-readiness.md');
    const markdown = page.locator('.doc-panel .artifact-markdown');
    await expect(markdown.locator('h1')).toBeVisible();

    const prose = await markdown.locator('p').first().evaluate((el) => {
      const font = parseFloat(getComputedStyle(el).fontSize);
      return el.getBoundingClientRect().width / font;
    });
    // ~80ch at the preview's size; comfortably short of the 100+ em a line ran.
    expect(prose).toBeLessThan(60);

    // Against the one-line header row, not the first body row: when the table
    // is squeezed every body row wraps alike (53px against a 33px header), so
    // comparing rows with each other passes over exactly the failure.
    const header = await markdown.locator('thead tr').evaluate((tr) => Math.round(tr.getBoundingClientRect().height));
    const rows = await markdown.locator('tbody tr').evaluateAll((trs) =>
      trs.map((tr) => Math.round(tr.getBoundingClientRect().height)),
    );
    for (const h of rows) expect(h, 'a table row wrapped onto a second line').toBeLessThanOrEqual(header + 1);

    // No scrollbar across the pane from the breakout.
    expect(await markdown.evaluate((el) => getComputedStyle(el).overflowX)).toBe('hidden');
  });

  test('keeps each fact of the status line whole in a narrow thread', async ({ page }) => {
    await openArtifacts(page);
    await page.getByRole('button', { name: 'Expand artifact' }).click();
    await expect.poll(() => width(page, '.center')).toBeLessThanOrEqual(420);
    const broken = await page.locator('.status > span').evaluateAll((spans) =>
      spans
        .filter((span) => span.getBoundingClientRect().height > parseFloat(getComputedStyle(span).lineHeight || '0') * 1.5 + 2)
        .map((span) => span.textContent),
    );
    expect(broken, 'these wrapped inside themselves').toEqual([]);
  });
});
