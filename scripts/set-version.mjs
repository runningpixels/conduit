// Write a release version into tauri.conf.json.
//
// The bundle version is read from tauri.conf.json, which is committed as a
// fixed value. Without this the tag and the build disagree: tagging v9.9.9
// would still produce 0.1.0 bundles, while the manifest job -- which is handed
// the tag's version -- would advertise a version no artifact carries.
//
//   node scripts/set-version.mjs 0.1.0-rc.1
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error(`set-version: "${version}" is not a semver version`);
  process.exit(1);
}

const configPath = 'apps/desktop/src-tauri/tauri.conf.json';
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const previousConfig = config.version;
config.version = version;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`tauri.conf.json version ${previousConfig} -> ${version}`);


// Only the version inside [workspace.package]. Scoped to that section so a
// dependency's own `version = "..."` is never rewritten; all three crates
// inherit it via `version.workspace = true`.
//
// This is also what env!("CARGO_PKG_VERSION") resolves to, and
// connector_runtime reports that to every MCP server as its client identity.
// Left alone, the app would bundle and update as 0.2.0 while introducing
// itself to connectors as 0.1.0, drifting further with every release.
//
// Cargo.lock is not touched: cargo refreshes the workspace member's version
// on the next build, and nothing in the pipeline passes --locked.
const cargoPath = 'Cargo.toml';
const cargo = readFileSync(cargoPath, 'utf8');
const workspaceVersion = /(\[workspace\.package\][^[]*?version\s*=\s*")([^"]+)(")/;
const found = cargo.match(workspaceVersion);
if (!found) {
  console.error('set-version: no [workspace.package] version found in Cargo.toml');
  process.exit(1);
}
writeFileSync(cargoPath, cargo.replace(workspaceVersion, `$1${version}$3`));
console.log(`Cargo.toml [workspace.package] version ${found[2]} -> ${version}`);