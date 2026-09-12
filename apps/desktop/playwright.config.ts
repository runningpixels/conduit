import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

/**
 * Layout checking under the pseudo-locale (Phase 4 of docs/plans/localization.md).
 *
 * Deliberately separate from `pnpm test`. Vitest's `include` is
 * `src/**\/*.test.{ts,tsx}`, and these specs live in `layout/` with a `.spec.ts`
 * extension, so the suite everyone runs is untouched — no browser, no new
 * flakiness, no slower CI. This is opt-in: `pnpm test:layout`.
 *
 * **No browser is ever downloaded.** `@playwright/test` has no postinstall, and
 * this drives a Chrome or Edge that is already on the machine via `channel`.
 * A fresh clone pays 13 MB of `node_modules` and nothing else; someone who
 * actually wants to run this needs a browser they almost certainly have.
 */

/** Where each channel's binary lives, per platform. */
const CANDIDATES: Record<string, { channel: string; paths: string[] }[]> = {
  win32: [
    {
      channel: 'chrome',
      paths: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ],
    },
    {
      channel: 'msedge',
      paths: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
    },
  ],
  darwin: [
    {
      channel: 'chrome',
      paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    },
    {
      channel: 'msedge',
      paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    },
  ],
  linux: [
    { channel: 'chrome', paths: ['/usr/bin/google-chrome', '/opt/google/chrome/chrome'] },
    { channel: 'msedge', paths: ['/usr/bin/microsoft-edge'] },
  ],
};

/**
 * The installed browser to drive, or `undefined` to fall back to a Playwright
 * chromium (which the runner will say is missing, with its own install hint).
 *
 * `PW_CHANNEL` overrides, for anyone whose browser is somewhere unusual.
 */
function detectChannel(): string | undefined {
  if (process.env.PW_CHANNEL) return process.env.PW_CHANNEL;
  for (const candidate of CANDIDATES[process.platform] ?? []) {
    if (candidate.paths.some((p) => existsSync(p))) return candidate.channel;
  }
  return undefined;
}

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
