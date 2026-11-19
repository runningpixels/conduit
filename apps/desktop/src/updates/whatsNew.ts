// "Updated to X · What's new": said once, on the first launch after the app
// version changes. The notes themselves live on the site changelog; the app
// only links there (scripts/release-notes.mjs builds the same link for the
// release page and the update manifest).

export const CHANGELOG_URL = 'https://conduitllm.com/changelog';

/** The site changelog's id for a release: 1.0.0-rc.34 -> v1-rc-34, 1.2.0 ->
 *  v1-2-0. Same rule as scripts/release-notes.mjs (a test keeps them equal). */
export function changelogAnchor(version: string): string | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!m) return null;
  const [, major, minor, patch, pre] = m;
  if (pre && minor === '0' && patch === '0') return `v${major}-${pre.replace(/\./g, '-')}`;
  const base = `v${major}-${minor}-${patch}`;
  return pre ? `${base}-${pre.replace(/\./g, '-')}` : base;
}

export function changelogLink(version: string): string {
  const anchor = changelogAnchor(version);
  return anchor ? `${CHANGELOG_URL}#${anchor}` : CHANGELOG_URL;
}

type Parsed = { core: [number, number, number]; pre: (number | string)[] };

function parse(version: string): Parsed | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version);
  if (!m) return null;
  const pre = m[4] ? m[4].split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
}

/** Semver order: negative when a < b. Null when either is not a version. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  // A release outranks its prereleases.
  if (!pa.pre.length || !pb.pre.length) return pb.pre.length - pa.pre.length;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export interface WhatsNewDecision {
  /** Show "Updated to <version>" with a link to its notes. */
  show: boolean;
  /** Save this as the last version seen (null: leave the setting alone). */
  record: string | null;
}

/**
 * Whether this launch follows an update.
 *
 * - A dev build (0.x) never shows or records anything, so switching between
 *   a dev build and the installed app does not toast every time.
 * - A fresh profile (onboarding not finished) records silently: a new install
 *   is not an update.
 * - A profile with no recorded version but finished onboarding is one from
 *   before this setting existed: it was updated, so it is told.
 * - Going back to an older version records it without a toast.
 */
export function whatsNewDecision(input: {
  current: string;
  lastSeen: string | null | undefined;
  onboardingCompleted: boolean;
}): WhatsNewDecision {
  const { current, lastSeen, onboardingCompleted } = input;
  const parsed = parse(current);
  if (!parsed || parsed.core[0] === 0) return { show: false, record: null };
  if (lastSeen === current) return { show: false, record: null };
  if (!onboardingCompleted) return { show: false, record: current };
  if (!lastSeen) return { show: true, record: current };
  const order = compareVersions(current, lastSeen);
  return { show: order != null && order > 0, record: current };
}
