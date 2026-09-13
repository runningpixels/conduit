import { defineConfig } from '@playwright/test';
import { detectChannel } from './playwright.shared';

/**
 * Layout checking under the pseudo-locale (Phase 4 of docs/plans/localization.md).
 *
 * Deliberately separate from `pnpm test`. Vitest's `include` is
 * `src/**\/*.test.{ts,tsx}`, and these specs live in `layout/` with a `.spec.ts`
 * extension, so the suite everyone runs is untouched — no browser, no new
 * flakiness, no slower CI. This is opt-in: `pnpm test:layout`.
 *
 * Browser-channel detection (`detectChannel`) is shared with
 * `playwright.visual.config.ts` in `playwright.shared.ts` — see that file for
 * why no browser is ever downloaded.
 */

const channel = detectChannel();

export default defineConfig({
  testDir: './layout',
  // Layout findings are not flaky in the way network tests are, and a retry
  // would only hide a real intermittent difference.
  retries: 0,
  reporter: [['list']],
  use: {
    ...(channel ? { channel } : {}),
    baseURL: 'http://localhost:5173',
  },
  webServer: {
    command: 'pnpm dev:web',
    url: 'http://localhost:5173',
    // Reuse a server the developer already has running; do not fight them for
    // the port.
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
