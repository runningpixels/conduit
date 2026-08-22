#!/usr/bin/env node
// Phase 6 M6.2 — Tauri 2 updater manifest generator.
//
// Reads the updater-signed bundle artifacts (+ their `.sig` files) from a Tauri
// `tauri build` output directory and emits a Tauri 2 updater-schema manifest:
//
//   {
//     "version": "1.2.3",
//     "notes": "Release notes …",
//     "pub_date": "2026-06-23T12:00:00Z",
//     "platforms": {
//       "windows-x86_64":  { "signature": "…", "url": "…" },
//       "darwin-aarch64":  { "signature": "…", "url": "…" },
//       "darwin-x86_64":   { "signature": "…", "url": "…" },
//       "linux-x86_64":    { "signature": "…", "url": "…" }
//     }
//   }
//
// The output path is `<outDir>/<channel>/manifest.json` so it matches the
// `updater.rs` endpoint shape (`<base>/<channel>/manifest.json`) exactly — M6.3
// just publishes both the `stable/` and `beta/` directories.
//
// OS code-signing is deferred (Phase 9/10): bundles ship unsigned at the OS
// level, but the updater payload itself is signature-verified — the `signature`
// here is the Ed25519 minisign signature Tauri emits next to each bundle
// (`TAURI_SIGNING_PRIVATE_KEY` in CI secrets; pubkey in `tauri.conf.json`).
//
// `min_app_version` gating is deferred to M6.3 (not part of the Tauri 2
// manifest schema); do not emit unknown fields the updater would ignore.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @typedef {Object} PlatformArtifact
 * @property {string} platform  Tauri 2 updater platform key
 *   ("windows-x86_64" | "darwin-aarch64" | "darwin-x86_64" | "linux-x86_64").
 * @property {string} signature The minisign signature (contents of the `.sig`).
 * @property {string} url       Download URL for the bundle.
 */

/**
 * @typedef {Object} BuildManifestOptions
 * @property {string} version   Semantic version of the release (no leading `v`).
 * @property {string} [notes]   Release notes body (markdown text).
 * @property {string} pubDate   ISO-8601 publish date (UTC, e.g. `2026-06-23T12:00:00Z`).
 * @property {PlatformArtifact[]} platforms  Per-platform signature + URL entries.
 */

/** Tauri 2 updater manifest platform keys this release targets. */
const PLATFORM_KEYS = new Set([
  'windows-x86_64',
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-x86_64',
]);

/**
 * Build a Tauri 2 updater manifest object from per-platform entries. Pure: no
 * I/O, so it is unit-tested directly. Throws on a malformed platform key or a
 * missing signature/URL so a bad release fails loudly rather than shipping a
 * partial manifest (the updater would then offer an update with no payload for
 * some platforms).
 *
 * @param {BuildManifestOptions} opts
 * @returns {object} the Tauri 2 updater manifest object
 */
export function buildManifest({ version, notes, pubDate, platforms }) {
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`manifest: invalid version "${version}" (expected semver)`);
  }
  if (!pubDate || !Number.isFinite(Date.parse(pubDate))) {
    throw new Error(`manifest: invalid pubDate "${pubDate}" (expected ISO-8601)`);
  }

  const byPlatform = {};
  for (const entry of platforms ?? []) {
    const { platform, signature, url } = entry;
    if (!PLATFORM_KEYS.has(platform)) {
      throw new Error(`manifest: unknown platform key "${platform}"`);
    }
    if (!signature || !signature.trim()) {
      throw new Error(`manifest: missing signature for ${platform}`);
    }
    if (!url || !/^https:\/\//.test(url)) {
      throw new Error(`manifest: missing or non-https URL for ${platform} ("${url}")`);
    }
    byPlatform[platform] = { signature: signature.trim(), url };
  }

  return {
    version,
    notes: notes ?? '',
    pub_date: pubDate,
    platforms: byPlatform,
  };
}

/**
 * Map a Tauri bundle filename to its updater platform key + the expected `.sig`
 * sibling filename. Tauri 2.11 emits:
 *   windows  → <name>_<version>_x64-setup.exe           (+ .sig)
 *   macos    → <name>_<version>_aarch64.app.tar.gz      (+ .sig)
 *              <name>_<version>_x64.app.tar.gz          (+ .sig)
 *   linux    → <name>_<version>_amd64.AppImage          (+ .sig)
 *
 * Verified against the `latest.json` tauri-action published for v0.1.0-rc.1,
 * which is the authority on what Tauri treats as an updater artifact. The
 * earlier patterns here (`x64-setup.nsis.zip`, `amd64.AppImage.tar.gz`) match
 * nothing it produces, so Windows and Linux silently dropped out of the
 * manifest while macOS carried on matching.
 *
 * `.deb` is signed too and appears in latest.json as `linux-x86_64-deb`, but
 * the AppImage is what `linux-x86_64` resolves to and what the updater pulls,
 * so it stays unclassified here.
 *
 * @param {string} filename
 * @returns {{ platform: string, sigFile: string } | null}
 */
export function classifyBundle(filename) {
  const sigFile = `${filename}.sig`;
  if (/x64-setup\.exe$/.test(filename)) {
    return { platform: 'windows-x86_64', sigFile };
  }
  if (/aarch64\.app\.tar\.gz$/.test(filename)) {
    return { platform: 'darwin-aarch64', sigFile };
  }
  if (/x64\.app\.tar\.gz$/.test(filename)) {
    return { platform: 'darwin-x86_64', sigFile };
  }
  if (/amd64\.AppImage$/.test(filename)) {
    return { platform: 'linux-x86_64', sigFile };
  }
  return null;
}

/**
 * Scan a Tauri build output directory for updater-signed bundles, read each
 * `.sig`, and return the per-platform entries for `buildManifest`. Each bundle's
 * download URL is `<downloadBase>/<filename>` (e.g. a GitHub Releases asset URL).
 *
 * @param {object} opts
 * @param {string} opts.artifactsDir Directory containing the bundles + `.sig` files.
 * @param {string} opts.downloadBase Base URL under which the bundles are hosted.
 * @returns {PlatformArtifact[]}
 */
export function collectPlatformArtifacts({ artifactsDir, downloadBase }) {
  const entries = [];
  for (const filename of readdirSync(artifactsDir)) {
    const classified = classifyBundle(filename);
    if (!classified) continue;
    const sigPath = join(artifactsDir, classified.sigFile);
    let signature;
    try {
      signature = readFileSync(sigPath, 'utf8');
    } catch {
      throw new Error(`manifest: missing signature file ${classified.sigFile} for ${filename}`);
    }
    const url = `${downloadBase.replace(/\/$/, '')}/${filename}`;
    entries.push({ platform: classified.platform, signature, url });
  }
  return entries;
}

/**
 * CLI entrypoint. Usage:
 *   node generate-update-manifest.mjs \
 *     --artifacts-dir <dir> --download-base <url> \
 *     --version <semver> --channel stable|beta \
 *     --out-dir <dir> [--notes <text>] [--pub-date <iso>]
 *
 * `--pub-date` defaults to the current UTC time. Writes
 * `<outDir>/<channel>/manifest.json`.
 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const pubDate = args.pubDate ?? new Date().toISOString();

  const platforms = collectPlatformArtifacts({
    artifactsDir: args.artifactsDir,
    downloadBase: args.downloadBase,
  });
  if (platforms.length === 0) {
    throw new Error(`manifest: no updater-signed bundles found in ${args.artifactsDir}`);
  }

  const manifest = buildManifest({
    version: args.version.replace(/^v/, ''),
    notes: args.notes,
    pubDate,
    platforms,
  });

  const outPath = join(args.outDir, args.channel, 'manifest.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`wrote ${outPath} for ${args.channel} (v${manifest.version}, ${platforms.length} platform(s))`);
  return outPath;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const raw = argv[i]?.replace(/^--/, '');
    if (!raw) continue;
    // `--artifacts-dir` → `artifactsDir` so callers use camelCase accessors.
    const key = raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1];
  }
  for (const required of ['artifactsDir', 'downloadBase', 'version', 'channel', 'outDir']) {
    if (!out[required]) {
      throw new Error(`manifest: --${required.replace(/([A-Z])/g, '-$1').toLowerCase()} is required`);
    }
  }
  if (out.channel !== 'stable' && out.channel !== 'beta') {
    throw new Error(`manifest: --channel must be "stable" or "beta" (got "${out.channel}")`);
  }
  return out;
}

// Run when invoked directly, not when imported by tests.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}