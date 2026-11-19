#!/usr/bin/env node
// Release notes for a tagged release, taken from CHANGELOG.md.
//
//   node scripts/release-notes.mjs --version 1.0.0-rc.35 --out notes.md
//       writes the GitHub release text: that version's CHANGELOG section,
//       a link to the site changelog, and the unsigned-bundles note.
//   node scripts/release-notes.mjs --version 1.0.0-rc.35 --link
//       prints the site changelog link for that version.
//
// A version with no CHANGELOG section (nightly, a dispatch run) still gets a
// release text: the link and the bundles note, never an empty body.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CHANGELOG_URL = 'https://conduitllm.com/changelog';

export const BUNDLES_NOTE =
  'OS bundles are unsigned (first-run Gatekeeper/SmartScreen prompt expected); updater payloads are signature-verified.';

// The site changelog's id for a release: 1.0.0-rc.34 -> v1-rc-34 (the ids the
// site already uses), 1.2.0 -> v1-2-0. Must match what the site gives each
// release, or the link opens at the top of the page instead of the entry.
export function changelogAnchor(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!m) return null;
  const [, major, minor, patch, pre] = m;
  if (pre && minor === '0' && patch === '0') return `v${major}-${pre.replace(/\./g, '-')}`;
  const base = `v${major}-${minor}-${patch}`;
  return pre ? `${base}-${pre.replace(/\./g, '-')}` : base;
}

export function changelogLink(version) {
  const anchor = changelogAnchor(version);
  return anchor ? `${CHANGELOG_URL}#${anchor}` : CHANGELOG_URL;
}

// The body of `## [version] - date` up to the next `## ` heading, trimmed.
// Null when the CHANGELOG has no such section.
export function changelogSection(text, version) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = lines.length;
  // Drop the link-reference footer ("[1.0.0]: https://...") if it is last.
  const body = lines.slice(start + 1, end).filter((l) => !/^\[[^\]]+\]:\s/.test(l));
  const out = body.join('\n').trim();
  return out || null;
}

export function releaseBody(changelogText, version) {
  const section = changelogSection(changelogText, version);
  const parts = [];
  if (section) parts.push(section);
  parts.push(`Release notes on the site: ${changelogLink(version)}`);
  parts.push(BUNDLES_NOTE);
  return parts.join('\n\n') + '\n';
}

export function main(argv = process.argv.slice(2)) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const version = arg('--version');
  if (!version) throw new Error('--version is required');
  if (argv.includes('--link')) {
    process.stdout.write(changelogLink(version) + '\n');
    return;
  }
  const changelogPath = arg('--changelog') ?? 'CHANGELOG.md';
  let text = '';
  try {
    text = readFileSync(changelogPath, 'utf8');
  } catch {
    // No CHANGELOG: the body is just the link and the bundles note.
  }
  const body = releaseBody(text, version);
  const out = arg('--out');
  if (out) writeFileSync(out, body);
  else process.stdout.write(body);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
