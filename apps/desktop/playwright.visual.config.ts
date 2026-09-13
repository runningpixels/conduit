import { defineConfig } from '@playwright/test';
import { detectChannel } from './playwright.shared';

/**
 * Local-only visual snapshot suite for the theming project (Phase 0).
 *
 * `visual/looks.spec.ts` drives `?route=gallery` (`src/devRoute.ts` /
 * `src/dev/Gallery.tsx`) across every palette × colour-scheme combination and
 * screenshots each gallery section, plus a few bare routes. The point is to
 * freeze what every surface looks like *before* the coming CSS-to-tokens
 * refactor, so that refactor can be checked against these baselines under a
 * "zero visual change" contract.
 *
 * Deliberately separate from both `pnpm test` (vitest) and `pnpm test:layout`
 * (structural Playwright assertions, no screenshots): baselines are
 * per-machine — font rasterisation differs across OSes — so
 * `visual/__screenshots__/` is gitignored and nobody's baseline is ever
 * compared against anybody else's. This is opt-in: `pnpm test:visual`.
 *
 * Browser-channel detection (`detectChannel`) is shared with
 * `playwright.config.ts` in `playwright.shared.ts` — see that file for why no
 * browser is ever downloaded.
 */

const channel = detectChannel();

export default defineConfig({
  testDir: './visual',
  snapshotDir: './visual/__screenshots__',
  // A pixel diff is not the kind of flake a retry fixes — it is either
  // deterministic or the test needs a wait fixed.
  retries: 0,
  reporter: [['list']],
  use: {
    ...(channel ? { channel } : {}),
    baseURL: 'http://localhost:5173',
    reducedMotion: 'reduce',
    launchOptions: {
      // Text is most of what a screenshot here differs on (the chat section's
      // markdown showcase most of all), and subpixel/LCD antialiasing is
      // rasterised slightly differently between separate browser process
      // launches on the same machine — not between real visual states, since
      // Playwright's own internal "wait for a stable frame" already passed
      // before comparing against the baseline. Grayscale AA and a pinned
      // colour profile remove that source of a real-but-invisible diff without
      // touching `maxDiffPixelRatio`, which stays the strict value asked for.
      args: ['--disable-lcd-text', '--force-color-profile=srgb'],
    },
  },
  expect: {
    toHaveScreenshot: {
      // The animations disabled here are re-asserted per-call in the spec;
      // this is the suite-wide default so a new test doesn't forget it.
      animations: 'disabled',
      maxDiffPixelRatio: 0.001,
    },
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
