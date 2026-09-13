import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Do hover-revealed controls land on top of localized text?
 *
 * `pseudoOverflow.spec.ts` next door measures *clipping* — text wider than the
 * box that cuts it off. This is the other half, and it needs its own file
 * because neither half sees the other's failures:
 *
 *   - The overlap here is not clipping. Nothing is cut off; two elements simply
 *     occupy the same pixels, and the one painted later wins.
 *   - It only exists on hover, and the walk next door never hovers.
 *   - It is in the conversation list, which `dev:web` cannot render at all —
 *     `listConversations` is IPC, and there is no Tauri backend behind it.
 *
 * So this drives the stylesheet directly, with the row's markup copied from
 * `Sidebar.tsx`, and feeds it the timestamps `formatTimeAgoTerse` can actually
 * produce in each shipped locale.
 *
 * The defect it was written for: the delete button is absolutely positioned
 * over the row's right edge, and the relative timestamp sat underneath it — a
 * 16px overlap, in every language. English hid it by having a three-character
 * word for "now"; Spanish did not, and "ahora" rendered with a trash can
 * through it.
 *
 * The row now carries a ⋯ actions button left of the trash, so the control the
 * timestamp must clear is whichever of the two is further left.
 */

const CSS = readFileSync(
  fileURLToPath(new URL('../src/styles/workspace.css', import.meta.url)),
  'utf8',
);

/** The shipped locales, and the terse "now" each catalog gives. */
const LOCALES = ['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-CN'] as const;

function catalog(locale: string): Record<string, string> {
  const file = locale === 'en' ? 'en.json' : `${locale}.json`;
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../src/i18n/messages/${file}`, import.meta.url)), 'utf8'),
  );
}

/**
 * Every shape `formatTimeAgoTerse` returns, per locale: the catalog's "now"
 * under a minute, a narrow unit above it, and an absolute date after a week.
 * Generated rather than hard-coded so a locale whose date format is long — or
 * whose word for "now" is — is measured as it will actually render.
 */
function stamps(locale: string): string[] {
  const unit = (value: number, u: 'minute' | 'hour' | 'day') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(value);
  return [
    catalog(locale)['common.time.now'],
    unit(59, 'minute'),
    unit(23, 'hour'),
    unit(6, 'day'),
    new Date('2026-09-10T12:00:00Z').toLocaleDateString(locale),
  ];
}

/* The sidebar's minimum width (useLayout.ts SIDEBAR_MIN), so the row is
 * measured where it is tightest. */
const SIDEBAR_WIDTH = 220;

test.describe('sidebar row', () => {
  for (const locale of LOCALES) {
    test(`the timestamp clears the row's buttons under ${locale}`, async ({ page }) => {
      await page.setContent(
        `<!doctype html><html lang="${locale}"><style>
           body { margin: 0; width: ${SIDEBAR_WIDTH}px; }
           ${CSS}
         </style>
         <div class="convo-row">
           <button class="convo" type="button" aria-current="true">
             <span class="convo-name">A conversation title long enough to need the ellipsis</span>
             <span class="convo-meta" id="meta"></span>
           </button>
           <button class="convo-more" id="more" type="button">M</button>
           <button class="convo-del" id="del" type="button">T</button>
         </div></html>`,
      );

      await page.hover('.convo-row');
      const overlaps: string[] = [];

      for (const stamp of stamps(locale)) {
        const overlap = await page.evaluate((value) => {
          const meta = document.getElementById('meta') as HTMLElement;
          meta.textContent = value;
          const m = meta.getBoundingClientRect();
          const d = (document.getElementById('more') as HTMLElement).getBoundingClientRect();
          /* An invisible timestamp cannot collide with anything, so only a
           * painted one is a finding — that is also what keeps this honest if
           * somebody decides to hide it on hover after all. */
          return getComputedStyle(meta).opacity === '0' ? 0 : Math.round(m.right - d.left);
        }, stamp);

        if (overlap > 0) overlaps.push(`"${stamp}" overlaps the row's buttons by ${overlap}px`);
      }

      expect(overlaps, `${locale} timestamps colliding with the row's buttons`).toEqual([]);
    });
  }
});
