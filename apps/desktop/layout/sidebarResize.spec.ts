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

/** Drags from the sash's centre to `toX`, in steps like a real hand. */
async function dragSashTo(page: Page, toX: number) {
  const box = await page.locator('.sidebar-resize').boundingBox();
  if (!box) throw new Error('sash has no box');
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
    const width = await sidebarWidth(page);
    expect(sash).not.toBeNull();
    expect(sash!.x).toBeLessThan(width);
    expect(sash!.x + sash!.width).toBeGreaterThan(width);
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
