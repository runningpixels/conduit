/**
 * Guard G9 — no hardcoded product-name literals.
 *
 * White-labelling moved product identity into two singletons —
 * `apps/desktop/src/brand/index.ts` on the renderer side and
 * `apps/desktop/src-tauri/src/brand.rs` on the Rust side — so a runtime
 * config or a build-time rebrand can change the name in one place. That seam
 * only holds if nothing routes around it. There is no ESLint in this repo to
 * pin a `no-restricted-syntax` rule against the bare string, so this test is
 * the only backstop: without it, the first person who writes `'Conduit'`
 * instead of calling `appName()` / `brand::app_name()` gets a green build,
 * and the indirection rots one literal at a time until a rebrand ships with
 * the old name still baked into half the UI.
 *
 * Scanned as text, not via the TS/Rust compilers, for the same reason G6 and
 * G8 do it: a literal string compiles and renders fine on its own — nothing
 * about it is a type error or a missing rule. The only way to see it is to
 * look at the source.
 *
 * Comment-stripping here is a line-based heuristic, not a parser, and it is
 * approximate on purpose (see `stripLineComment` below): it is tuned to the
 * shapes of comment actually used in this codebase, not to survive
 * adversarial input. That trade is fine for a guard that runs against code
 * written by people trying to keep it green, not against code trying to
 * defeat it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '..', '..'); // apps/desktop
const tsRoot = join(desktopRoot, 'src');
const rustRoot = join(desktopRoot, 'src-tauri', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Posix-style path relative to apps/desktop, for stable reporting and matching. */
function rel(file: string): string {
  return relative(desktopRoot, file).split(sep).join('/');
}

const tsFiles = walk(tsRoot)
  .filter((f) => /\.tsx?$/.test(f))
  .filter((f) => !/\.test\.tsx?$/.test(f))
  // The renderer's own definition of the default, and the generated module
  // it now reads that default from (`./generated.ts`, stock Conduit values
  // by default — see its module comment), legitimately contain the literal.
  // That is the one place — really, the one seam — it is *supposed* to live.
  .filter((f) => !['src/brand/index.ts', 'src/brand/generated.ts'].includes(rel(f)));

const rustFiles = walk(rustRoot)
  .filter((f) => f.endsWith('.rs'))
  .filter((f) => !f.split(sep).includes('tests'))
  .filter((f) => !/\.test\.rs$/.test(f))
  // Same exemption, Rust half.
  .filter((f) => rel(f) !== 'src-tauri/src/brand.rs');

/**
 * Strip a trailing line comment, if this line has one outside a string.
 *
 * Handles `//`, `///` and `//!` uniformly, since a triple-slash or bang
 * comment is just a `//` comment with extra punctuation immediately after —
 * finding the first `//` and cutting there covers all three. The one
 * deliberate exception is `://` (as in `https://…`), guarded with a
 * lookbehind so a URL embedded in a real string literal does not get read as
 * "everything after this is a comment". Nothing here tracks quotes, so a
 * literal `//` that occurs mid-string in some *other* form would still cut
 * early — that has not happened anywhere in this tree, and if it ever does
 * the fix is to widen this function, not the allowlist below.
 */
function stripLineComment(line: string): string {
  const m = line.match(/(?<!:)\/\//);
  return m ? line.slice(0, m.index) : line;
}

/**
 * Remove `/* … *\/` block comments (including `/** … *\/` doc comments and
 * their `*`-prefixed continuation lines, since those live inside the same
 * delimiters). Newlines inside the comment are preserved so every remaining
 * line keeps its original line number.
 */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
}

/** Lines carrying identity that is not a user-visible product name at all. */
const LINE_IGNORE_PATTERNS: RegExp[] = [
  // localStorage key prefixes: 'conduit:v7-...'. Lowercase already keeps
  // these out of the case-sensitive `Conduit` match below; listed explicitly
  // anyway so the exemption is documented rather than an accident of case.
  /\bconduit:v\d+-/,
  // Workspace package imports/specifiers: '@conduit/ui', '@conduit/config-schema'.
  /@conduit\//,
];

interface Occurrence {
  file: string;
  line: number;
  text: string;
}

/** Every bare, whole-word `Conduit` occurrence outside comments, across both trees. */
function findOccurrences(files: string[]): Occurrence[] {
  const out: Occurrence[] = [];
  for (const file of files) {
    const raw = readFileSync(file, 'utf8');
    const stripped = stripBlockComments(raw).split('\n');
    stripped.forEach((rawLine, i) => {
      const line = stripLineComment(rawLine);
      if (LINE_IGNORE_PATTERNS.some((p) => p.test(line))) return;
      // Case-sensitive, whole-word: this is what keeps `conduit_desktop`,
      // `CONDUIT_ARTIFACT_SYSTEM_APPENDIX`, `CONDUIT_UPDATE_BASE` and
      // `conduitllm.com` out — none of them contain the substring `Conduit`
      // (capital C, lowercase rest) as a delimited word, so `\b` never
      // lines up around them.
      if (/\bConduit\b/.test(line)) {
        out.push({ file: rel(file), line: i + 1, text: line.trim() });
      }
    });
  }
  return out;
}

/**
 * Wire/protocol identity that must NOT be rebranded — changing any of these
 * is a breaking change to something outside this app's own UI (a User-Agent
 * another service parses, an MCP handshake field, or the on-disk data
 * directory), not a cosmetic rename. Each entry is matched against the
 * offending line's text, so it exempts exactly the identifier named in
 * `reason`, not the whole file.
 */
const WIRE_IDENTITY_ALLOWLIST: { file: string; pattern: RegExp; reason: string }[] = [
  {
    file: 'src-tauri/src/updater.rs',
    pattern: /Conduit-Updater\//,
    reason:
      'Update-check User-Agent sent to the release server. The server (or an operator reading its ' +
      'access logs) identifies this client by this string; renaming it silently is an update-channel break, not a rebrand.',
  },
  {
    file: 'src-tauri/src/connector_runtime/mod.rs',
    pattern: /name:\s*"Conduit"\.to_string\(\)/,
    reason:
      "ClientInfo.name sent to MCP servers during the initialize handshake. It identifies the client " +
      'to the connector, not the user; some servers allowlist or log by this field.',
  },
  {
    file: 'src-tauri/src/commands/connectors.rs',
    pattern: /name:\s*"Conduit"\.to_string\(\)/,
    reason:
      "ClientInfo.name sent to MCP servers during the initialize handshake (OAuth discovery path). Same wire identity as connector_runtime.",
  },
  {
    file: 'src-tauri/src/mcp_registry.rs',
    pattern: /user_agent\("Conduit-MCP\/0\.1"\)/,
    reason:
      'User-Agent on official MCP registry HTTP requests. The registry (and operators reading access logs) identify this client by this string.',
  },
  {
    file: 'src-tauri/src/agent_tools.rs',
    pattern: /"User-Agent",\s*"Conduit\/1\.0"/,
    reason:
      'Outbound User-Agent on tool-initiated HTTP requests (e.g. artifact link fetches). Third-party ' +
      'servers and their rate limiters key off this string.',
  },
  {
    file: 'src-tauri/src/paths.rs',
    pattern: /ProjectDirs::from\("com",\s*"Conduit",/,
    reason:
      'Organisation qualifier for the on-disk data directory (ProjectDirs). Changing it points existing ' +
      "installs at an empty directory — it's a breaking data-directory migration, not a display-name change.",
  },
];

/**
 * Strings a user never reads on a working install. Kept separate from the wire
 * identity above because the two are exempt for opposite reasons: a User-Agent
 * must stay fixed, whereas these are simply not worth the cost of migrating.
 * That difference is why these are excluded from the presence assertion below —
 * nothing breaks if one of them is reworded.
 */
const DEVELOPER_FACING_ALLOWLIST: { file: string; pattern: RegExp; reason: string }[] = [
  {
    file: 'src-tauri/src/main.rs',
    pattern: /\.expect\("failed to build Conduit desktop shell"\)/,
    reason:
      'Panic message on Tauri builder failure — the app never reaches a window, so no user reads it. ' +
      'Interpolating a brand would mean `.expect(&format!(..))`, which trips clippy::expect_fun_call, ' +
      'and CI runs clippy with -D warnings. Not worth restructuring a panic path for a crash-only string.',
  },
];

const ALLOWLIST = [...WIRE_IDENTITY_ALLOWLIST, ...DEVELOPER_FACING_ALLOWLIST];

describe('brand literals', () => {
  const occurrences = findOccurrences([...tsFiles, ...rustFiles]);

  it('has no unmigrated "Conduit" literal in user-visible source', () => {
    const violations = occurrences.filter(
      (o) => !ALLOWLIST.some((a) => a.file === o.file && a.pattern.test(o.text)),
    );

    const report = violations.map((v) => `  ${v.file}:${v.line}  ${v.text}`).join('\n');
    expect(
      violations,
      `hardcoded "Conduit" literal(s) found — replace with appName() (TS, ` +
        `apps/desktop/src/brand) or brand::app_name() (Rust, apps/desktop/src-tauri/src/brand.rs):\n${report}`,
    ).toEqual([]);
  });

  it('keeps the wire-identity allowlist honest: every entry still matches its file', () => {
    // The mirror of the check above. If a rename silently swallows one of
    // these — "Conduit-Updater/" becomes "Foo-Updater/" without anyone
    // updating this table — the literal scan goes quiet (nothing named
    // `Conduit` remains to flag) and the break would otherwise ship
    // unnoticed. Asserting presence, not just tolerating it, is what makes
    // this a guard on the wire identity rather than a hole in the first one.
    for (const entry of WIRE_IDENTITY_ALLOWLIST) {
      const path = join(desktopRoot, ...entry.file.split('/'));
      const content = readFileSync(path, 'utf8');
      expect(
        entry.pattern.test(content),
        `${entry.file}: expected wire identity matching ${entry.pattern} (${entry.reason}) — it is missing or was reworded`,
      ).toBe(true);
    }
  });

  it('the allowlists name only files this guard actually scans', () => {
    const scanned = new Set([...tsFiles, ...rustFiles].map(rel));
    for (const entry of ALLOWLIST) {
      expect(scanned.has(entry.file), `${entry.file} is allowlisted but is not in the scanned file set`).toBe(
        true,
      );
    }
  });
});
