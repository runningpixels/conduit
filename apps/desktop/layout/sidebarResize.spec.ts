import { expect, test, type Page } from '@playwright/test';

/**
 * The sidebar's sash, driven with a real pointer.
 *
 * `useLayout.test.ts` covers the arithmetic — clamps, persistence, the snap —
 * against synthetic events in jsdom. What jsdom cannot tell us is whether the
 * handle is actually *under* the pointer where the border is drawn, whether
 * the grid track follows it without easing, and whether the column's content
 * survives the minimum width. Those need a browser and real layout.
 *
 * `dev:web` has no Tauri backend, so the sidebar shows its empty state; the
 * shell chrome around it is what is measured here.
 */

const VIEWPORT = { width: 1440, height: 900 };

async function openShell(page: Page, locale = 'en') {
  await page.goto(`/?locale=${encodeURIComponent(locale)}`);
  await page.waitForSelector('.sidebar-resize', { timeout: 30_000 });
}

async function sidebarWidth(page: Page): Promise<number> {
  return page.locator('.sidebar').evaluate((el) => Math.round(el.getBoundingClientRect().width));
}

/**
 * Drags from the sash's centre to where the sidebar's right edge would be at
 * `width`, in steps like a real hand. The sidebar no longer starts at x=0 —
 * the activity rail sits to its left — so the target is measured from the
 * sidebar's own left edge.
 */
async function dragSashTo(page: Page, width: number) {
  const box = await page.locator('.sidebar-resize').boundingBox();
  if (!box) throw new Error('sash has no box');
  const left = await page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().left);
  const toX = left + width;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(toX, y, { steps: 8 });
  return {
    release: () => page.mouse.up(),
  };
}

test.describe('the sidebar sash', () => {
  test.use({ viewport: VIEWPORT });

  test.beforeEach(async ({ page }) => {
    await openShell(page);
    await page.evaluate(() => {
      localStorage.removeItem('conduit:v5-layout');
      localStorage.removeItem('conduit:v5-sidebar');
    });
    await openShell(page);
  });

  test('sits on the sidebar border', async ({ page }) => {
    const sash = await page.locator('.sidebar-resize').boundingBox();
    const border = await page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().right);
    expect(sash).not.toBeNull();
    expect(sash!.x).toBeLessThan(border);
    expect(sash!.x + sash!.width).toBeGreaterThan(border);
  });

  test('the sidebar starts flush against the activity rail', async ({ page }) => {
    const rail = await page.locator('.rail').boundingBox();
    const sidebar = await page.locator('.sidebar').boundingBox();
    expect(rail).not.toBeNull();
    expect(Math.round(sidebar!.x)).toBe(Math.round(rail!.x + rail!.width));
  });

  test('tracks the pointer with no easing, and persists across a reload', async ({ page }) => {
    const drag = await dragSashTo(page, 360);
    // Measured before release and without waiting: the .22s collapse
    // transition must not be running during the drag.
    expect(await sidebarWidth(page)).toBe(360);
    await drag.release();
    expect(await sidebarWidth(page)).toBe(360);

    await openShell(page);
    expect(await sidebarWidth(page)).toBe(360);
  });

  test('clamps to its min and max', async ({ page }) => {
    await (await dragSashTo(page, 150)).release();
    expect(await sidebarWidth(page)).toBe(220);
    await (await dragSashTo(page, 900)).release();
    expect(await sidebarWidth(page)).toBe(480);
  });

  test('resets on double-click', async ({ page }) => {
    await (await dragSashTo(page, 400)).release();
    await page.locator('.sidebar-resize').dblclick();
    // Not a drag, so the reset eases like a collapse does.
    await expect.poll(() => sidebarWidth(page)).toBe(280);
  });

  test('snaps shut when dragged past half its min width, and reopens at its prior width', async ({ page }) => {
    await (await dragSashTo(page, 320)).release();
    await (await dragSashTo(page, 40)).release();
    await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'closed');

    await page.getByRole('button', { name: 'Open sidebar' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'open');
    await expect.poll(() => sidebarWidth(page)).toBe(320);
  });

  test('is hidden, and resizing is off, where the sidebar is force-collapsed', async ({ page }) => {
    await page.setViewportSize({ width: 880, height: 800 });
    await expect(page.locator('.sidebar-resize')).toBeHidden();
  });
});

test.describe('the sidebar at its minimum width', () => {
  test.use({ viewport: VIEWPORT });

  /* The longest-running locales, at 220px. Measured per element so a failure
   * names what spilled rather than handing over a screenshot. Text that
   * ellipsises on purpose clips by design and is not a spill: what matters is
   * nothing reaching past the column's edge, where .sidebar's overflow:hidden
   * would cut it off. */
  for (const locale of ['en', 'en-XA', 'de']) {
    test(`nothing overhangs the column under ${locale}`, async ({ page }) => {
      await openShell(page, locale);
      await page.evaluate(() => localStorage.setItem('conduit:v5-layout', JSON.stringify({ sidebarW: 220 })));
      await openShell(page, locale);
      expect(await sidebarWidth(page)).toBe(220);

      // The footer menu opens upward inside the column; measure it open.
      await page.locator('.wschip').click();
      await expect(page.locator('.ws-menu')).toHaveAttribute('data-open', 'true');

      const overhang = await page.locator('.sidebar').evaluate((sidebar) => {
        const edge = sidebar.getBoundingClientRect().right;
        return Array.from(sidebar.querySelectorAll<HTMLElement>('*'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.right > edge + 0.5;
          })
          .map((el) => `${el.tagName.toLowerCase()}.${el.className} → ${Math.round(el.getBoundingClientRect().right - edge)}px`);
      });
      expect(overhang, `these reach past the sidebar edge under ${locale}`).toEqual([]);
    });
  }
});
