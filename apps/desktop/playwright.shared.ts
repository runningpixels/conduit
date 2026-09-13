import { existsSync } from 'node:fs';

/**
 * Shared browser-channel detection for the two local-only Playwright configs
 * (`playwright.config.ts` — the layout suite, and `playwright.visual.config.ts`
 * — the theming gallery's visual snapshot suite).
 *
 * **No browser is ever downloaded.** `@playwright/test` has no postinstall, and
 * this drives a Chrome or Edge that is already on the machine via `channel`. A
 * fresh clone pays a few MB of `node_modules` and nothing else; someone who
 * actually wants to run either suite needs a browser they almost certainly
 * have.
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
export function detectChannel(): string | undefined {
  if (process.env.PW_CHANNEL) return process.env.PW_CHANNEL;
  for (const candidate of CANDIDATES[process.platform] ?? []) {
    if (candidate.paths.some((p) => existsSync(p))) return candidate.channel;
  }
  return undefined;
}
