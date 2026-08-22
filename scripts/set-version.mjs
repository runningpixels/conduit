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

const path = 'apps/desktop/src-tauri/tauri.conf.json';
const config = JSON.parse(readFileSync(path, 'utf8'));
const previous = config.version;
config.version = version;
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
console.log(`tauri.conf.json version ${previous} -> ${version}`);
