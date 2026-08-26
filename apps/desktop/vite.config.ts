import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(new URL(import.meta.url)));

/**
 * Phase 6 white-label (Mode B): `scripts/apply-brand-identity.mjs` writes
 * `branding.build.json` next to this file from brand.md's
 * `[runtime] allowUserBranding`. Read synchronously here, at config-eval
 * time, rather than via an env var threaded through `pnpm build` -- a real
 * file means every later `vite build`/`vite dev` in any shell picks up the
 * same decision automatically. Absent (the stock, non-branded checkout) it
 * defaults to `true`: Settings -> Branding stays available unless a brand
 * build explicitly locked it off. See `src/brand/buildFlags.ts`, the one
 * place this define is read.
 *
 * This same file is also what vitest evaluates for its own `test:` block
 * below -- Vite has no separate config for "test mode" -- so
 * `__ALLOW_USER_BRANDING__` genuinely is defined under vitest, not absent as
 * `src/brand/buildFlags.ts` used to claim. Left to read branding.build.json
 * like a real build would, a developer who ran the brand script locally
 * (branding.build.json is gitignored, so `git status` never shows it) would
 * get a `pnpm test` run that silently used whatever brand was applied last
 * in that checkout, diverging from CI's clean one. Vitest sets
 * `process.env.VITEST`, so every test run gets the same, deterministic
 * `true` regardless of what a previous brand run left on disk.
 */
function readAllowUserBranding(): boolean {
  if (process.env.VITEST) return true;
  const flagsPath = path.join(rootDir, 'branding.build.json');
  if (!existsSync(flagsPath)) return true;
  try {
    const parsed = JSON.parse(readFileSync(flagsPath, 'utf8'));
    return parsed.allowUserBranding !== false;
  } catch {
    // A malformed branding.build.json fails open to the safe default
    // (Branding stays available) rather than breaking the build.
    return true;
  }
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@conduit/config-schema': path.resolve(rootDir, '../../packages/config-schema/src'),
      '@conduit/ui': path.resolve(rootDir, '../../packages/ui/src'),
    },
  },
  define: {
    __ALLOW_USER_BRANDING__: JSON.stringify(readAllowUserBranding()),
  },
  server: {
    port: 5173,
  },
  test: {
    // M6: artifact renderer tests need a DOM. Pure-function tests (escape,
    // buildArtifactCsp, selectRenderer dispatch) also pass under jsdom.
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
