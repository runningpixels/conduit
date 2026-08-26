import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Repo-root tooling script (Phase 6 white-label, Mode B). Plain ESM JS with
// no type bindings; vitest runs it directly. `@ts-ignore` keeps `tsc -b`
// (`pnpm check`) quiet about the missing declaration, following the same
// precedent as generate-update-manifest.test.ts. Unlike that script, this one
// deliberately carries no shebang: generate-update-manifest.mjs's does, and
// this suite would otherwise reproduce the exact Rolldown "Invalid Character
// `!`" parse failure that script's own test currently has.
// @ts-ignore
import * as brandIdentity from '../../../../scripts/apply-brand-identity.mjs';

const {
  REPO_ROOT,
  patchTauriConfig,
  assertHasUpdater,
  MISSING_UPDATER_MESSAGE,
  deriveUpdateBase,
  allowUserBranding,
  writeBuildFlags,
  writeUpdateBaseEnv,
  resetTauriConfig,
  applyBrandIdentity,
  parseArgv,
  assertIconsDirClean,
  restoreIconsFromGit,
} = brandIdentity;

const STOCK_TAURI_CONF = {
  $schema: 'https://schema.tauri.app/config/2',
  productName: 'Conduit',
  version: '0.1.0',
  identifier: 'io.github.runningpixels.conduit',
  app: {
    windows: [{ label: 'main', title: 'Conduit', width: 1360, height: 900 }],
  },
  bundle: {
    active: true,
    publisher: 'Emilio Olivares',
    copyright: 'Copyright © 2026 Emilio Olivares. AGPL-3.0-only.',
    shortDescription: 'Local-first AI assistant with connectors and artifacts.',
    longDescription: 'Conduit is a local-first desktop AI assistant.',
  },
  plugins: {
    updater: {
      pubkey: 'STOCK_PUBKEY==',
      windows: { installMode: 'passive' },
      endpoints: ['https://runningpixels.github.io/conduit/stable/manifest.json'],
    },
  },
};

function stockConfText() {
  return `${JSON.stringify(STOCK_TAURI_CONF, null, 2)}\n`;
}

// A minimal, valid BrandConfig-shaped object (the JSON envelope
// print_brand_json would emit), used by the pure-function tests so they
// don't need to shell out to cargo.
const FULL_CONFIG = {
  schemaVersion: 1,
  identity: { appName: 'Northwind', displayName: 'Northwind AI' },
  bundle: {
    productName: 'Northwind AI',
    identifier: 'com.northwind.ai',
    publisher: 'Northwind Ltd',
    copyright: 'Copyright (c) 2026 Northwind Ltd.',
    shortDescription: "Northwind's assistant",
    longDescription: 'The Northwind assistant, on your machine.',
  },
  updater: {
    endpoint: 'https://updates.northwind.example/stable/manifest.json',
    pubkey: 'northwind-pubkey',
  },
  runtime: { allowUserBranding: false },
};

// Real `+++` brand.md source for the two integration-level tests that shell
// out to the actual Rust parser (crates/provider-core/examples/
// print_brand_json.rs) -- proving the JSON envelope this script consumes
// really is what Rust's validator produces, not a shape this suite invented.
const FULL_BRAND_MD = `+++
schemaVersion = 1

[identity]
appName = "Northwind"
displayName = "Northwind AI"

[bundle]
productName = "Northwind AI"
identifier = "com.northwind.ai"
publisher = "Northwind Ltd"
copyright = "Copyright (c) 2026 Northwind Ltd."
shortDescription = "Northwind's assistant"
longDescription = "The Northwind assistant, on your machine."

[updater]
endpoint = "https://updates.northwind.example/stable/manifest.json"
pubkey = "northwind-pubkey"

[runtime]
allowUserBranding = false
+++

# Northwind design notes
`;

const NO_UPDATER_BRAND_MD = `+++
schemaVersion = 1

[identity]
appName = "Northwind"
displayName = "Northwind AI"
+++
`;

// Brand B: only sets the two required-by-convention [bundle] fields
// (productName/identifier) and omits publisher/copyright/shortDescription/
// longDescription entirely, to prove a re-run does not inherit brand A's
// (Northwind's) values for the fields it leaves unset.
const MINIMAL_BUNDLE_BRAND_MD = `+++
schemaVersion = 1

[identity]
appName = "Southwind"
displayName = "Southwind AI"

[bundle]
productName = "Southwind"
identifier = "com.southwind.ai"

[updater]
endpoint = "https://updates.southwind.example/stable/manifest.json"
pubkey = "southwind-pubkey"
+++
`;

describe('patchTauriConfig (pure)', () => {
  it('patches productName, identifier, window title, and bundle metadata', () => {
    const patched = JSON.parse(patchTauriConfig(stockConfText(), FULL_CONFIG));
    expect(patched.productName).toBe('Northwind AI');
    expect(patched.identifier).toBe('com.northwind.ai');
    expect(patched.app.windows[0].title).toBe('Northwind AI');
    expect(patched.bundle.publisher).toBe('Northwind Ltd');
    expect(patched.bundle.copyright).toBe('Copyright (c) 2026 Northwind Ltd.');
    expect(patched.bundle.shortDescription).toBe("Northwind's assistant");
    expect(patched.bundle.longDescription).toBe('The Northwind assistant, on your machine.');
  });

  it('patches both updater mechanisms: endpoints and pubkey, no env indirection', () => {
    const patched = JSON.parse(patchTauriConfig(stockConfText(), FULL_CONFIG));
    expect(patched.plugins.updater.endpoints).toEqual([
      'https://updates.northwind.example/stable/manifest.json',
    ]);
    expect(patched.plugins.updater.pubkey).toBe('northwind-pubkey');
  });

  it('leaves optional bundle fields untouched when brand.md omits them', () => {
    const minimal = {
      ...FULL_CONFIG,
      bundle: { productName: 'Northwind AI', identifier: 'com.northwind.ai' },
    };
    const patched = JSON.parse(patchTauriConfig(stockConfText(), minimal));
    expect(patched.bundle.publisher).toBe('Emilio Olivares');
    expect(patched.bundle.copyright).toBe('Copyright © 2026 Emilio Olivares. AGPL-3.0-only.');
  });

  it('leaves productName/identifier/title untouched when [bundle] is absent entirely', () => {
    const noBundle = { ...FULL_CONFIG, bundle: undefined };
    const patched = JSON.parse(patchTauriConfig(stockConfText(), noBundle));
    expect(patched.productName).toBe('Conduit');
    expect(patched.identifier).toBe('io.github.runningpixels.conduit');
    expect(patched.app.windows[0].title).toBe('Conduit');
  });

  it('refuses to patch when [updater] is missing, even defensively', () => {
    const noUpdater = { ...FULL_CONFIG, updater: undefined };
    expect(() => patchTauriConfig(stockConfText(), noUpdater)).toThrow(/no \[updater\] section/);
  });

  it('running twice from the same brand config produces byte-identical output', () => {
    const once = patchTauriConfig(stockConfText(), FULL_CONFIG);
    const twice = patchTauriConfig(once, FULL_CONFIG);
    expect(twice).toBe(once);
  });
});

describe('assertHasUpdater', () => {
  it('throws the hard-fail message when [updater] is absent', () => {
    expect(() => assertHasUpdater({})).toThrow(MISSING_UPDATER_MESSAGE);
  });

  it('throws when endpoint or pubkey is missing even if the section exists', () => {
    expect(() => assertHasUpdater({ updater: { endpoint: 'https://x/stable/manifest.json' } })).toThrow();
    expect(() => assertHasUpdater({ updater: { pubkey: 'abc' } })).toThrow();
  });

  it('does not throw when both fields are present', () => {
    expect(() =>
      assertHasUpdater({ updater: { endpoint: 'https://x/stable/manifest.json', pubkey: 'abc' } }),
    ).not.toThrow();
  });
});

describe('deriveUpdateBase', () => {
  it('strips /<channel>/manifest.json to get the base', () => {
    expect(deriveUpdateBase('https://updates.northwind.example/stable/manifest.json')).toBe(
      'https://updates.northwind.example',
    );
    expect(deriveUpdateBase('https://updates.example.com/foo/beta/manifest.json')).toBe(
      'https://updates.example.com/foo',
    );
  });

  it('rejects a URL that does not end in /stable|beta/manifest.json', () => {
    expect(() => deriveUpdateBase('https://updates.example.com/manifest.json')).toThrow(
      /does not end in/,
    );
  });

  it('rejects a non-URL', () => {
    expect(() => deriveUpdateBase('not-a-url')).toThrow(/not a valid URL/);
  });
});

describe('allowUserBranding', () => {
  it('defaults to true when [runtime] is absent', () => {
    expect(allowUserBranding({})).toBe(true);
  });

  it('honors an explicit false', () => {
    expect(allowUserBranding({ runtime: { allowUserBranding: false } })).toBe(false);
  });

  it('honors an explicit true', () => {
    expect(allowUserBranding({ runtime: { allowUserBranding: true } })).toBe(true);
  });
});

describe('writeBuildFlags / writeUpdateBaseEnv', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-brand-flags-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a JSON file vite.config.ts can read synchronously', () => {
    const file = join(dir, 'branding.build.json');
    writeBuildFlags(file, false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ allowUserBranding: false });
  });

  it('writes a .env-style CONDUIT_UPDATE_BASE line', () => {
    const file = join(dir, '.env.branding');
    writeUpdateBaseEnv(file, 'https://updates.northwind.example');
    expect(readFileSync(file, 'utf8')).toBe('CONDUIT_UPDATE_BASE=https://updates.northwind.example\n');
  });
});

describe('resetTauriConfig', () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conduit-brand-reset-'));
    configPath = join(dir, 'tauri.conf.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores from a backup and deletes it', () => {
    writeFileSync(`${configPath}.brand-backup`, stockConfText());
    writeFileSync(configPath, patchTauriConfig(stockConfText(), FULL_CONFIG));

    const restored = resetTauriConfig(configPath);

    expect(restored).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe(stockConfText());
    expect(existsSync(`${configPath}.brand-backup`)).toBe(false);
  });

  it('is a no-op when there is no backup', () => {
    writeFileSync(configPath, stockConfText());
    const restored = resetTauriConfig(configPath);
    expect(restored).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(stockConfText());
  });
});

// Icons have no `.brand-backup` sidecar (see the "Icons: reversibility,
// chosen deliberately" comment in apply-brand-identity.mjs above
// assertIconsDirClean) -- git is the backup instead, since none of the 18
// icon files are gitignored. These tests exercise that machinery directly,
// against a real throwaway `git init`'d repo, without running the actual
// (Python/Pillow/Tauri-CLI-dependent) icon-rendering pipeline.
describe('assertIconsDirClean / restoreIconsFromGit', () => {
  let repoRoot: string;
  let iconsDir: string;
  let iconFile: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'conduit-icons-git-'));
    execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    iconsDir = join(repoRoot, 'apps/desktop/src-tauri/icons');
    mkdirSync(iconsDir, { recursive: true });
    iconFile = join(iconsDir, 'icon.png');
    writeFileSync(iconFile, 'stock-icon-bytes');
    execFileSync('git', ['add', '-A'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--quiet', '-m', 'stock icons'], { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('does not throw when the icons directory is clean', () => {
    expect(() => assertIconsDirClean(repoRoot, iconsDir)).not.toThrow();
  });

  it('throws when the icons directory has uncommitted changes', () => {
    writeFileSync(iconFile, 'mixed-brand-bytes');
    expect(() => assertIconsDirClean(repoRoot, iconsDir)).toThrow(/is not clean/);
  });

  it('warns instead of throwing when there is no git repository at all', () => {
    const noGitDir = mkdtempSync(join(tmpdir(), 'conduit-icons-no-git-'));
    try {
      const noGitIcons = join(noGitDir, 'icons');
      mkdirSync(noGitIcons, { recursive: true });
      writeFileSync(join(noGitIcons, 'icon.png'), 'anything');
      expect(() => assertIconsDirClean(noGitDir, noGitIcons)).not.toThrow();
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });

  it('restoreIconsFromGit undoes an in-progress (partial-pipeline) write and reports success', () => {
    writeFileSync(iconFile, 'mixed-brand-bytes');
    const restored = restoreIconsFromGit(repoRoot, iconsDir);
    expect(restored).toBe(true);
    expect(readFileSync(iconFile, 'utf8')).toBe('stock-icon-bytes');
  });

  it('restoreIconsFromGit reports false (no-op) when there is no git repository', () => {
    const noGitDir = mkdtempSync(join(tmpdir(), 'conduit-icons-no-git-2-'));
    try {
      const noGitIcons = join(noGitDir, 'icons');
      mkdirSync(noGitIcons, { recursive: true });
      expect(restoreIconsFromGit(noGitDir, noGitIcons)).toBe(false);
    } finally {
      rmSync(noGitDir, { recursive: true, force: true });
    }
  });
});

describe('parseArgv', () => {
  it('recognizes --reset regardless of position', () => {
    expect(parseArgv(['--reset'])).toEqual({ reset: true });
    expect(parseArgv(['some-dir', '--reset'])).toEqual({ reset: true });
  });

  it('picks the first non-flag argument as the brand dir', () => {
    expect(parseArgv(['./my-brand', '--skip-icons'])).toEqual({
      reset: false,
      brandDir: './my-brand',
      skipIcons: true,
    });
  });

  it('defaults skipIcons to false', () => {
    expect(parseArgv(['./my-brand'])).toEqual({
      reset: false,
      brandDir: './my-brand',
      skipIcons: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: the real Rust parser, a throwaway tauri.conf.json fixture.
//
// `repoRoot` is a temp directory holding only a copy of tauri.conf.json (so
// the real, committed one is never at risk), but `cargoRoot` stays the real
// repository -- `cargo run --example print_brand_json -p provider-core` has
// to execute inside the actual Cargo workspace. `--skip-icons` avoids
// needing Python/Pillow/the Tauri CLI in CI for what is a config-patching
// test, not an icon-rendering one (make-icon.py's own parameterization is
// exercised directly against the real repo icons directory separately).
// ---------------------------------------------------------------------------
describe('applyBrandIdentity (real Rust parser + a throwaway tauri.conf.json)', () => {
  let repoRoot: string;
  let brandDir: string;
  let configPath: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'conduit-brand-repo-'));
    mkdirSync(join(repoRoot, 'apps/desktop/src-tauri'), { recursive: true });
    configPath = join(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json');
    writeFileSync(configPath, stockConfText());

    brandDir = mkdtempSync(join(tmpdir(), 'conduit-brand-md-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(brandDir, { recursive: true, force: true });
  });

  it('exits non-zero (throws) and leaves tauri.conf.json untouched when [updater] is absent', () => {
    writeFileSync(join(brandDir, 'brand.md'), NO_UPDATER_BRAND_MD);

    expect(() =>
      applyBrandIdentity({ brandDir, repoRoot, cargoRoot: REPO_ROOT, skipIcons: true }),
    ).toThrow(/no \[updater\] section/);

    // Refuse to proceed means no partial mutation, not just a thrown error.
    expect(readFileSync(configPath, 'utf8')).toBe(stockConfText());
    expect(existsSync(`${configPath}.brand-backup`)).toBe(false);
  }, 300_000);

  it('patches tauri.conf.json, writes build flags + update-base env, and is idempotent', () => {
    writeFileSync(join(brandDir, 'brand.md'), FULL_BRAND_MD);

    const first = applyBrandIdentity({
      brandDir,
      repoRoot,
      cargoRoot: REPO_ROOT,
      skipIcons: true,
    });
    const afterFirst = readFileSync(configPath, 'utf8');

    const conf = JSON.parse(afterFirst);
    expect(conf.productName).toBe('Northwind AI');
    expect(conf.identifier).toBe('com.northwind.ai');
    expect(conf.app.windows[0].title).toBe('Northwind AI');
    expect(conf.plugins.updater.endpoints).toEqual([
      'https://updates.northwind.example/stable/manifest.json',
    ]);
    expect(conf.plugins.updater.pubkey).toBe('northwind-pubkey');
    expect(first.updateBase).toBe('https://updates.northwind.example');
    expect(first.allowUserBranding).toBe(false);

    const flags = JSON.parse(readFileSync(join(repoRoot, 'apps/desktop/branding.build.json'), 'utf8'));
    expect(flags).toEqual({ allowUserBranding: false });
    const env = readFileSync(join(repoRoot, '.env.branding'), 'utf8');
    expect(env).toBe('CONDUIT_UPDATE_BASE=https://updates.northwind.example\n');

    applyBrandIdentity({ brandDir, repoRoot, cargoRoot: REPO_ROOT, skipIcons: true });
    const afterSecond = readFileSync(configPath, 'utf8');
    expect(afterSecond).toBe(afterFirst);
  }, 300_000);

  it('patches from stock on every run, so a later brand does not inherit an earlier brand\'s optional [bundle] fields', () => {
    // Brand A sets every optional [bundle] field.
    writeFileSync(join(brandDir, 'brand.md'), FULL_BRAND_MD);
    applyBrandIdentity({ brandDir, repoRoot, cargoRoot: REPO_ROOT, skipIcons: true });
    const afterA = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(afterA.bundle.publisher).toBe('Northwind Ltd');
    expect(afterA.bundle.copyright).toBe('Copyright (c) 2026 Northwind Ltd.');
    expect(afterA.bundle.shortDescription).toBe("Northwind's assistant");
    expect(afterA.bundle.longDescription).toBe('The Northwind assistant, on your machine.');

    // Brand B, applied in the SAME checkout (no --reset in between, exactly
    // like a reused CI checkout), sets only productName/identifier and
    // leaves the four optional fields unset. None of brand A's values may
    // survive.
    const brandDirB = mkdtempSync(join(tmpdir(), 'conduit-brand-md-b-'));
    try {
      writeFileSync(join(brandDirB, 'brand.md'), MINIMAL_BUNDLE_BRAND_MD);
      applyBrandIdentity({ brandDir: brandDirB, repoRoot, cargoRoot: REPO_ROOT, skipIcons: true });
      const afterB = JSON.parse(readFileSync(configPath, 'utf8'));

      expect(afterB.productName).toBe('Southwind');
      expect(afterB.identifier).toBe('com.southwind.ai');
      expect(afterB.bundle.publisher).toBe(STOCK_TAURI_CONF.bundle.publisher);
      expect(afterB.bundle.copyright).toBe(STOCK_TAURI_CONF.bundle.copyright);
      expect(afterB.bundle.shortDescription).toBe(STOCK_TAURI_CONF.bundle.shortDescription);
      expect(afterB.bundle.longDescription).toBe(STOCK_TAURI_CONF.bundle.longDescription);
    } finally {
      rmSync(brandDirB, { recursive: true, force: true });
    }
  }, 300_000);

  it('--reset restores tauri.conf.json after a real apply', () => {
    writeFileSync(join(brandDir, 'brand.md'), FULL_BRAND_MD);
    applyBrandIdentity({ brandDir, repoRoot, cargoRoot: REPO_ROOT, skipIcons: true });
    expect(readFileSync(configPath, 'utf8')).not.toBe(stockConfText());

    const restored = resetTauriConfig(configPath);

    expect(restored).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toBe(stockConfText());
  }, 300_000);
});
