// Phase 6 white-label: bake a brand's identity into a packaged build.
//
//   node scripts/apply-brand-identity.mjs <brand-dir> [--skip-icons]
//   node scripts/apply-brand-identity.mjs --reset
//
// Patches apps/desktop/src-tauri/tauri.conf.json (productName, identifier,
// window title, publisher, copyright, descriptions, updater endpoint+pubkey),
// writes the build-time flag Vite bakes into `allowUserBranding`, emits the
// CONDUIT_UPDATE_BASE value the build must compile with, and regenerates the
// app icons from the brand's own logo/palette -- Mode B of
// docs/private/white-label-plan.md §5. Same read-mutate-write discipline as
// set-version.mjs: read the committed file, patch known fields, write it
// back whole.
//
// WHY THIS SCRIPT DOES NOT PARSE brand.md ITSELF
// ------------------------------------------------
// brand.md's `+++` TOML frontmatter already has one parser + validator:
// `provider_core::brand::parse` (crates/provider-core/src/brand.rs), which
// Mode A's `get_brand_config`/`import_brand_file` IPC commands call at
// runtime. Writing a second, JavaScript, parser here would let "what
// Settings -> Branding accepted" and "what a packaged build accepted" drift
// apart -- exactly the failure the white-label plan calls out as the one
// that destroys trust in this feature. So this script shells out to a Rust
// binary instead, the same pattern `packages/config-schema`'s own build
// script already uses (`cargo run --example export_ts -p provider-core`):
// crates/provider-core/examples/print_brand_json.rs parses + validates with
// the *exact* function Mode A uses and prints the resulting `BrandConfig` as
// one line of JSON. See that file's doc comment for the exact contract.
//
// No top-level shebang: apps/desktop/src/scripts/generate-update-manifest.mjs
// carries one and its own test (generate-update-manifest.test.ts) fails to
// even parse under vitest's Rolldown-based SSR transform because of it. This
// file is meant to be imported by apps/desktop/src/scripts/
// apply-brand-identity.test.ts, so it stays shebang-free and instead guards
// its side-effecting entry point behind the `isMain` check at the bottom,
// mirroring that same file's `main()`/`isMain` idiom.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TAURI_CONF_REL = 'apps/desktop/src-tauri/tauri.conf.json';
// Read by apps/desktop/vite.config.ts to set the __ALLOW_USER_BRANDING__
// define. Lives inside apps/desktop/, not the repo root, so a relative
// `fs.readFileSync` from vite.config.ts needs no path.resolve gymnastics.
const BUILD_FLAGS_REL = 'apps/desktop/branding.build.json';
// `.env.*` is already gitignored (see .gitignore) -- this never needs its
// own entry, and it can never accidentally get committed.
const UPDATE_BASE_ENV_REL = '.env.branding';
// Unlike the three paths above, this directory's 18 files are NOT
// gitignored -- Conduit's own stock icons are ordinary committed binaries.
// See the "Icons: reversibility, chosen deliberately" comment above
// `assertIconsDirClean` for what that implies for backup/reset.
const ICONS_DIR_REL = 'apps/desktop/src-tauri/icons';

// =============================================================================
// Step 0: shell out to Rust for parse + validate
// =============================================================================

/**
 * Run `print_brand_json` against `<brandDir>/brand.md` and return the parsed
 * envelope: `{ ok: true, config, warnings }` or
 * `{ ok: false, errors, message }`. `cargoRoot` is always the real repo (the
 * Cargo workspace root) regardless of where `brandDir` lives or which
 * `repoRoot` the caller is patching files under -- tests patch a throwaway
 * `repoRoot` but must still shell out to the one real `cargo`.
 *
 * @param {string} brandDir absolute path to the directory containing brand.md
 * @param {{ cargoRoot?: string }} [opts]
 */
export function runPrintBrandJson(brandDir, { cargoRoot = REPO_ROOT } = {}) {
  let stdout;
  try {
    stdout = execFileSync(
      'cargo',
      ['run', '--quiet', '--example', 'print_brand_json', '-p', 'provider-core', '--', brandDir],
      { cwd: cargoRoot, encoding: 'utf8' },
    );
  } catch (err) {
    const stderr = err.stderr?.toString().trim();
    throw new Error(
      `apply-brand-identity: failed to run the Rust brand parser (print_brand_json)` +
        `${stderr ? `: ${stderr}` : ` (${err.message})`}`,
    );
  }
  // print_brand_json writes exactly one JSON line to stdout; take the last
  // non-empty line defensively in case a toolchain ever leaks a stray line
  // above it despite --quiet.
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines[lines.length - 1];
  try {
    return JSON.parse(line ?? '');
  } catch (err) {
    throw new Error(
      `apply-brand-identity: print_brand_json did not print valid JSON: ${err.message}\n${stdout}`,
    );
  }
}

// =============================================================================
// Step 1/2: the updater hard-fail
// =============================================================================

export const MISSING_UPDATER_MESSAGE = [
  'apply-brand-identity: brand.md has no [updater] section. Refusing to produce a build.',
  '',
  "A packaged build that inherits Conduit's own update endpoint would poll upstream's",
  'manifest and could never verify its own signatures against a key it does not hold',
  '(see apps/desktop/src-tauri/src/updater.rs:44-56 -- forks MUST point this at their',
  "own infrastructure). That is a silent, shipped defect, so it must be impossible to",
  'produce by omission. Add to brand.md:',
  '',
  '  [updater]',
  '  endpoint = "https://updates.example.com/stable/manifest.json"',
  '  pubkey   = "<your own minisign public key>"',
  '',
  'and run this again.',
].join('\n');

/**
 * Hard-fail if `[updater]` is absent or incomplete. Called before any file is
 * touched -- "refuse to proceed" means no backup, no patch, no icons, not a
 * patch that quietly skips the updater section.
 */
export function assertHasUpdater(config) {
  if (!config?.updater?.endpoint || !config?.updater?.pubkey) {
    throw new Error(MISSING_UPDATER_MESSAGE);
  }
}

// =============================================================================
// Step 1: tauri.conf.json — bundle metadata + updater identity
// =============================================================================

/**
 * Patch `configText` (the current contents of tauri.conf.json) with the
 * `[bundle]` and `[updater]` sections of a validated `BrandConfig`. Pure:
 * takes text, returns text, touches no filesystem -- the read-mutate-write
 * discipline of set-version.mjs, split so the "mutate" half is unit-testable
 * on its own.
 *
 * `[bundle]` is optional in brand.md (`BrandConfig.bundle: Option<...>`), so
 * a brand that only restyles colours and does not care about the installer
 * name is legal -- productName/identifier/title are left exactly as they
 * are in `configText`. `[updater]` is not optional here: callers MUST run
 * `assertHasUpdater` first, and this function re-asserts it defensively so
 * it is never safe to call on its own with a config missing one.
 *
 * `publisher`/`copyright`/`shortDescription`/`longDescription` are each
 * patched only when brand.md actually sets them (all four are optional on
 * `BrandBundle`) -- an omitted field is left as whatever `configText` already
 * holds rather than being blanked, so a reseller who only cares about the
 * name and identifier does not end up shipping an installer with empty
 * description fields.
 *
 * This function is pure and has no opinion on *which* text that is -- it is
 * the caller's job to make "whatever configText already holds" mean
 * something safe. `applyBrandIdentity` below always calls this with the
 * pristine `.brand-backup` copy (see `ensureBackup`/`resetTauriConfig`), never
 * with `configPath` itself, precisely so that "already holds" always means
 * Conduit's own stock text, on every run, not whichever brand happened to
 * apply last in this checkout. Feeding it a live, previously-patched file
 * instead would let brand A's publisher/copyright/description silently
 * survive into brand B's build wherever brand B's brand.md omits that field
 * -- exactly the failure the "patches from stock, not from the last brand"
 * test below guards against.
 */
export function patchTauriConfig(configText, config) {
  assertHasUpdater(config);
  const conf = JSON.parse(configText);

  if (config.bundle) {
    const b = config.bundle;
    conf.productName = b.productName;
    conf.identifier = b.identifier;
    if (conf.app?.windows?.[0]) {
      conf.app.windows[0].title = b.productName;
    }
    if (b.publisher != null) conf.bundle.publisher = b.publisher;
    if (b.copyright != null) conf.bundle.copyright = b.copyright;
    if (b.shortDescription != null) conf.bundle.shortDescription = b.shortDescription;
    if (b.longDescription != null) conf.bundle.longDescription = b.longDescription;
  }

  // No env indirection here, unlike CONDUIT_UPDATE_BASE below: Tauri reads
  // `plugins.updater.endpoints`/`pubkey` straight out of this JSON file at
  // bundle time (for `createUpdaterArtifacts`) and there is no built-in
  // mechanism to override them from an environment variable. Missing this
  // half while only setting CONDUIT_UPDATE_BASE is the exact "different
  // mechanisms, missing one is the likely failure" case the plan warns
  // about -- the app's own runtime checks would use the reseller's
  // endpoint (via CONDUIT_UPDATE_BASE), but Tauri's own updater plugin
  // config, and anything that reads it directly, would still say Conduit's.
  conf.plugins.updater.endpoints = [config.updater.endpoint];
  conf.plugins.updater.pubkey = config.updater.pubkey;

  return `${JSON.stringify(conf, null, 2)}\n`;
}

// =============================================================================
// Reversibility: backup + reset
// =============================================================================

function backupPathFor(configPath) {
  return `${configPath}.brand-backup`;
}

/**
 * Save a copy of `configPath` the first time this script touches it. Never
 * overwritten by a later run, so it always holds the pristine, stock
 * content -- which is what makes `--reset` idempotent-safe and what makes
 * running this script twice in a row not compound (the second run patches
 * from the *already-branded* file, but the backup it could roll back to is
 * still the original).
 */
function ensureBackup(configPath) {
  const backup = backupPathFor(configPath);
  if (!existsSync(backup)) {
    copyFileSync(configPath, backup);
  }
}

/**
 * Restore `configPath` from its backup, if one exists, and delete the
 * backup. Returns `false` (a no-op) when there is nothing to restore --
 * either `--reset` was already run, or this script never touched the file
 * in this checkout, in which case the file is presumably already stock.
 *
 * Deliberately independent of git: tests exercise this against a throwaway
 * temp directory with no repository at all, and a reseller's build
 * pipeline may run this script against a working tree that was never
 * `git init`'d (e.g. a extracted release tarball). The repo's own
 * `tauri.conf.json` can equally be restored with `git checkout --
 * apps/desktop/src-tauri/tauri.conf.json`; this is the same guarantee for
 * environments where that is not available.
 */
export function resetTauriConfig(configPath) {
  const backup = backupPathFor(configPath);
  if (!existsSync(backup)) {
    return false;
  }
  copyFileSync(backup, configPath);
  rmSync(backup);
  return true;
}

function removeIfExists(filePath) {
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
}

// =============================================================================
// Step 4: allowUserBranding — a build-time constant the renderer reads
// =============================================================================

/**
 * `BrandRuntime.allow_user_branding` defaults to `true` in Rust
 * (`#[serde(default = "default_true_bool")]`) whenever `[runtime]` is
 * *present* but the key is omitted. When the whole `[runtime]` section is
 * absent -- `config.runtime` is `null`/`undefined` in the JSON envelope --
 * there is no Rust default to inherit, so this mirrors it here: an
 * unbranded build (or a brand.md that never mentions `[runtime]`) keeps
 * Settings -> Branding.
 */
export function allowUserBranding(config) {
  return config?.runtime?.allowUserBranding ?? true;
}

/**
 * Write the tiny JSON file `apps/desktop/vite.config.ts` reads synchronously
 * at config-eval time to set the `__ALLOW_USER_BRANDING__` define. A real
 * file on disk rather than an environment variable threaded through `pnpm
 * build`, so the decision is captured once, here, at apply time, and every
 * later `vite build`/`vite dev` invocation (by anyone, in any shell) picks
 * it up automatically instead of needing to remember to re-export a var.
 */
export function writeBuildFlags(filePath, allow) {
  writeFileSync(filePath, `${JSON.stringify({ allowUserBranding: allow }, null, 2)}\n`);
}

// =============================================================================
// Step 2: CONDUIT_UPDATE_BASE
// =============================================================================

/**
 * Derive the channel-agnostic `CONDUIT_UPDATE_BASE` from brand.md's
 * `[updater] endpoint`. `updater.rs` builds the URL it actually calls as
 * `"{CONDUIT_UPDATE_BASE}/{channel}/manifest.json"` (channel is `stable` or
 * `beta`), so `endpoint` -- documented and templated as the *stable*
 * manifest URL -- must end in exactly that shape for the base to be
 * unambiguous. Throws rather than guessing at a different layout: a wrong
 * guess here is the same class of silent defect the updater hard-fail
 * above exists to prevent, just one step further downstream.
 */
export function deriveUpdateBase(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`apply-brand-identity: [updater] endpoint "${endpoint}" is not a valid URL`);
  }
  const match = url.pathname.match(/^(.*)\/(stable|beta)\/manifest\.json$/);
  if (!match) {
    throw new Error(
      `apply-brand-identity: [updater] endpoint "${endpoint}" does not end in ` +
        '/stable/manifest.json or /beta/manifest.json. updater.rs builds the per-channel ' +
        'URL itself as "{CONDUIT_UPDATE_BASE}/{channel}/manifest.json", so endpoint must be ' +
        'the *stable*-channel manifest URL and CONDUIT_UPDATE_BASE is everything before that.',
    );
  }
  url.pathname = match[1] || '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Write `CONDUIT_UPDATE_BASE` to a `.env`-style file rather than exporting it
 * into the current process's environment: `option_env!("CONDUIT_UPDATE_BASE")`
 * (updater.rs:55) is resolved by the Rust compiler at *compile* time, so it
 * must be present in the environment of the later `cargo build`/`cargo tauri
 * build` invocation specifically, which this script does not run (icon
 * generation aside, this script only patches config; the actual build is a
 * separate pipeline step, often a different process or CI job entirely).
 * A file that step's shell can `source`/load is the only form that survives
 * that boundary reliably. Documented in the log line `main()` prints after
 * writing it.
 */
export function writeUpdateBaseEnv(filePath, base) {
  writeFileSync(filePath, `CONDUIT_UPDATE_BASE=${base}\n`);
}

// =============================================================================
// Step 3: icons
// =============================================================================

function run(cmd, args, cwd) {
  // `pnpm` is `pnpm.cmd` on Windows, and Windows refuses to exec a `.cmd`
  // directly (EINVAL) without going through a shell -- `python`/`cargo` are
  // real executables and need no such thing. Node warns (DEP0190) that
  // `shell: true` with an argument array only concatenates rather than
  // escapes them; every argument passed to `pnpm` here is either a fixed
  // literal or a path this same script just computed (never brand-authored
  // text), and this is an operator-invoked build tool, not a network-facing
  // one, so that tradeoff is accepted rather than hand-rolling Windows shell
  // quoting.
  const needsShell = process.platform === 'win32' && cmd === 'pnpm';
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: needsShell });
}

/**
 * Icons: reversibility, chosen deliberately
 * -------------------------------------------
 * None of the 18 files `runIconPipeline` overwrites are gitignored (see
 * .gitignore) -- Conduit's own stock icons are ordinary committed binaries,
 * same as any other checked-in asset. That makes git itself the backup.
 * `tauri.conf.json`/`branding.build.json`/`.env.branding` above instead use
 * a hand-rolled `.brand-backup` sidecar, deliberately, so that machinery
 * keeps working with no git repository at all (an extracted release
 * tarball, or the throwaway temp-dir fixtures this file's own tests use).
 * Duplicating 18 binary files into a second sidecar copy here purely to
 * reimplement what `git checkout --` already does for free is not worth the
 * bytes or the bookkeeping, so this pipeline leans on git instead:
 *
 *   - Before touching anything, refuse to run if the icons directory is
 *     already dirty (`assertIconsDirClean`). A prior interrupted run left a
 *     mixed-brand set behind, or there are unrelated local edits in
 *     progress -- this tool cannot tell those apart, and starting a
 *     *second* multi-step overwrite on top of an unknown state is how a
 *     mixed set becomes an undiscoverable one. Refusing forces the operator
 *     to resolve it first (typically `git checkout --
 *     apps/desktop/src-tauri/icons/`).
 *   - If the pipeline itself dies partway through (make-icon.py -> tauri
 *     icon -> make-icon.py --macos -> tauri icon -o tmp is four external
 *     processes, any of which can fail), `git checkout --` on the icons
 *     directory undoes exactly the partial write, because the clean check
 *     above already proved the tree was stock before this run started.
 *   - `--reset` (`main()`, below) restores icons the same way, alongside
 *     the existing tauri.conf.json/branding.build.json/.env.branding reset
 *     -- brand.md's icons and its config now share one `--reset` path
 *     instead of only the config half being covered.
 *
 * All of this degrades to a clear warning, not a throw, when `repoRoot` is
 * not a git repository at all (`isGitRepo` returns false): that is exactly
 * the "extracted release tarball" environment the tauri.conf.json backup
 * above is also written to support, and this pipeline still has to run
 * there (`--skip-icons` aside). There is no git-free way to reset icons in
 * that environment short of re-extracting stock assets, and this tool says
 * so rather than silently pretending to guarantee something it cannot.
 */

/**
 * Whether `repoRoot` is inside a git working tree -- the same question
 * `git rev-parse --is-inside-work-tree` answers, asked via that exact
 * command so this agrees with git's own notion of "is there a repo here"
 * rather than a homemade `existsSync('.git')` check (which a worktree or a
 * submodule can make misleading). `false` covers both "no git binary on
 * PATH" and "not a repo at all".
 */
function isGitRepo(repoRoot) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse to proceed if the icons directory already has uncommitted changes.
 * A no-op warning, not a throw, when there is no git repository to check
 * against (see the module comment above) -- there is nothing this function
 * can verify in that environment, and the pipeline must still be usable
 * there.
 */
export function assertIconsDirClean(repoRoot, iconsDir) {
  if (!isGitRepo(repoRoot)) {
    console.warn(
      `apply-brand-identity: no git repository found at ${repoRoot} -- cannot verify the icons ` +
        'directory is clean before writing, and cannot recover it automatically if this pipeline ' +
        'fails partway through. If this run is interrupted, restore apps/desktop/src-tauri/icons/ ' +
        'from a stock checkout by hand before applying another brand.',
    );
    return;
  }
  let status;
  try {
    status = execFileSync('git', ['status', '--porcelain', '--', iconsDir], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (err) {
    console.warn(
      `apply-brand-identity: \`git status\` on the icons directory failed (${err.message}) -- ` +
        'proceeding without the pre-flight clean check.',
    );
    return;
  }
  if (status.trim()) {
    throw new Error(
      'apply-brand-identity: apps/desktop/src-tauri/icons/ is not clean (git status shows ' +
        'uncommitted changes there). Refusing to regenerate icons on top of an unknown state -- ' +
        'this is either a previous run that died partway through (leaving a mixed-brand icon set ' +
        'on disk) or unrelated local edits. Run `git status -- apps/desktop/src-tauri/icons/` to ' +
        'see what changed, and `git checkout -- apps/desktop/src-tauri/icons/` to discard it, ' +
        `before running this again.\n\n${status}`,
    );
  }
}

/**
 * Best-effort `git checkout --` on the icons directory. Returns whether it
 * actually ran (i.e. there was a git repository to run it against) -- not
 * whether the directory changed, since a checkout against an already-stock
 * tree is a harmless no-op and both callers (the pipeline's failure path and
 * `--reset`) only need to know whether they were able to act.
 */
export function restoreIconsFromGit(repoRoot, iconsDir) {
  if (!isGitRepo(repoRoot)) return false;
  try {
    execFileSync('git', ['checkout', '--', iconsDir], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Regenerate the app icon set from the brand's own logo and/or palette, via
 * `scripts/make-icon.py --logo/--hue/--bg` and `tauri icon` -- exactly the
 * two-invocation pipeline documented at the top of make-icon.py (a
 * full-bleed source for Windows/Linux, a squircle-inset source for
 * icon.icns), just with the brand's inputs instead of BrandMark's hardcoded
 * transcription.
 *
 * Skipped (leaving Conduit's own committed icons untouched) when brand.md
 * has neither `[logo]` nor `[palette]` -- there is nothing to regenerate
 * from, and running the pipeline anyway would just re-render the exact same
 * built-in glyph in the exact same default colours.
 */
export function runIconPipeline({ repoRoot = REPO_ROOT, brandDir, config }) {
  const hasLogo = Boolean(config.logo);
  const hasPalette = Boolean(config.palette);
  if (!hasLogo && !hasPalette) {
    console.log(
      "apply-brand-identity: brand.md has no [logo] or [palette] -- app icons stay Conduit's own.",
    );
    return;
  }

  const iconsDir = path.join(repoRoot, ICONS_DIR_REL);
  assertIconsDirClean(repoRoot, iconsDir);

  // The dark palette, to match make-icon.py's own default plate (a dark
  // charcoal) and because an icon needs exactly one background, not two.
  const dark = config.palette?.dark;
  const colourArgs = [];
  if (dark?.hue) colourArgs.push('--hue', dark.hue);
  if (dark?.bg) colourArgs.push('--bg', dark.bg);
  const logoArgs = hasLogo ? ['--logo', path.join(brandDir, config.logo.file)] : [];

  try {
    run('python', ['scripts/make-icon.py', ...colourArgs, ...logoArgs], repoRoot);
    run(
      'pnpm',
      ['-C', 'apps/desktop', 'exec', 'tauri', 'icon', path.join(iconsDir, 'icon-source-1024.png')],
      repoRoot,
    );

    run('python', ['scripts/make-icon.py', '--macos', ...colourArgs, ...logoArgs], repoRoot);
    const tmpOut = mkdtempSync(path.join(tmpdir(), 'conduit-icon-'));
    try {
      run(
        'pnpm',
        [
          '-C',
          'apps/desktop',
          'exec',
          'tauri',
          'icon',
          path.join(iconsDir, 'icon-source-macos-1024.png'),
          '-o',
          tmpOut,
        ],
        repoRoot,
      );
      copyFileSync(path.join(tmpOut, 'icon.icns'), path.join(iconsDir, 'icon.icns'));
    } finally {
      rmSync(tmpOut, { recursive: true, force: true });
    }
  } catch (err) {
    // The clean check above already proved the tree was stock before this
    // run started, so a `git checkout --` here undoes exactly this run's
    // partial write -- never more, never a guess.
    const restored = restoreIconsFromGit(repoRoot, iconsDir);
    throw new Error(
      `apply-brand-identity: icon pipeline failed partway through (${err.message}). ` +
        (restored
          ? `${ICONS_DIR_REL}/ has been restored to its state before this run via \`git checkout --\`.`
          : `${ICONS_DIR_REL}/ may now hold a mixed-brand icon set (no git repository available to ` +
            'restore it automatically) -- restore it by hand before shipping a build.'),
    );
  }

  console.log('apply-brand-identity: regenerated app icons from brand.md');
}

// =============================================================================
// Orchestration
// =============================================================================

/**
 * Everything except the CLI wiring. Throws (never calls `process.exit`) so
 * both `main()` and tests can control what happens on failure.
 *
 * `repoRoot` is where tauri.conf.json / branding.build.json / .env.branding
 * are read and written; `cargoRoot` is where `cargo run` executes. They are
 * the same directory (`REPO_ROOT`) in real use and are only ever split apart
 * in tests, which patch a throwaway `repoRoot` fixture but must still shell
 * out to the one real Cargo workspace to parse brand.md.
 */
export function applyBrandIdentity({
  brandDir,
  repoRoot = REPO_ROOT,
  cargoRoot = REPO_ROOT,
  skipIcons = false,
} = {}) {
  if (!brandDir) {
    throw new Error('apply-brand-identity: a brand directory is required');
  }
  const resolvedBrandDir = path.isAbsolute(brandDir)
    ? brandDir
    : path.resolve(process.cwd(), brandDir);

  const parsed = runPrintBrandJson(resolvedBrandDir, { cargoRoot });
  if (!parsed.ok) {
    const detail = (parsed.errors ?? []).map((e) => `  - ${e.field}: ${e.message}`).join('\n');
    throw new Error(
      `apply-brand-identity: ${resolvedBrandDir}/brand.md failed validation: ${parsed.message}` +
        `${detail ? `\n${detail}` : ''}`,
    );
  }
  const { config, warnings } = parsed;
  for (const w of warnings) {
    console.warn(`apply-brand-identity: warning (${w.field}): ${w.message}`);
  }

  // Hard-fail before anything below this line touches a file.
  assertHasUpdater(config);

  if (!config.bundle) {
    console.warn(
      'apply-brand-identity: brand.md has no [bundle] section -- productName, identifier, and ' +
        "the window title stay Conduit's own. A reseller almost always wants this filled in.",
    );
  }

  const configPath = path.join(repoRoot, TAURI_CONF_REL);
  ensureBackup(configPath);
  // Read from the backup, not from configPath: configPath may already carry
  // a previous run's branding (reused CI checkout, or applying brand B right
  // after brand A with no `--reset` in between), and the backup is the one
  // copy `ensureBackup` guarantees is always stock. See patchTauriConfig's
  // doc comment above for why reading the live file instead would leak an
  // earlier brand's optional fields into a later one that omits them.
  const stockConfigText = readFileSync(backupPathFor(configPath), 'utf8');
  const patched = patchTauriConfig(stockConfigText, config);
  writeFileSync(configPath, patched);
  console.log(`apply-brand-identity: patched ${TAURI_CONF_REL}`);

  const allow = allowUserBranding(config);
  writeBuildFlags(path.join(repoRoot, BUILD_FLAGS_REL), allow);
  console.log(`apply-brand-identity: wrote ${BUILD_FLAGS_REL} (allowUserBranding=${allow})`);

  const updateBase = deriveUpdateBase(config.updater.endpoint);
  writeUpdateBaseEnv(path.join(repoRoot, UPDATE_BASE_ENV_REL), updateBase);
  console.log(
    `apply-brand-identity: wrote ${UPDATE_BASE_ENV_REL} (CONDUIT_UPDATE_BASE=${updateBase})`,
  );
  console.log(
    'apply-brand-identity: CONDUIT_UPDATE_BASE is read via option_env! at COMPILE time -- ' +
      `source ${UPDATE_BASE_ENV_REL} into the environment before running ` +
      '`cargo build`/`cargo tauri build`, not just before launching the app.',
  );

  if (!skipIcons) {
    runIconPipeline({ repoRoot, brandDir: resolvedBrandDir, config });
  } else {
    console.log('apply-brand-identity: --skip-icons set, app icons left untouched');
  }

  return { config, warnings, updateBase, allowUserBranding: allow };
}

// =============================================================================
// CLI
// =============================================================================

export function parseArgv(argv) {
  if (argv.includes('--reset')) {
    return { reset: true };
  }
  return {
    reset: false,
    brandDir: argv.find((a) => !a.startsWith('--')),
    skipIcons: argv.includes('--skip-icons'),
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgv(argv);

  if (args.reset) {
    const configPath = path.join(REPO_ROOT, TAURI_CONF_REL);
    const restored = resetTauriConfig(configPath);
    removeIfExists(path.join(REPO_ROOT, BUILD_FLAGS_REL));
    removeIfExists(path.join(REPO_ROOT, UPDATE_BASE_ENV_REL));
    console.log(
      restored
        ? `apply-brand-identity: reset ${TAURI_CONF_REL} to stock.`
        : `apply-brand-identity: ${TAURI_CONF_REL} was already stock (no backup found).`,
    );

    // Icons have no `.brand-backup` sidecar (see the "Icons: reversibility,
    // chosen deliberately" comment above assertIconsDirClean) -- git IS the
    // backup, since none of the 18 files are gitignored, so `--reset`
    // restores them the same way a partial pipeline failure does.
    const iconsDir = path.join(REPO_ROOT, ICONS_DIR_REL);
    const iconsRestored = restoreIconsFromGit(REPO_ROOT, iconsDir);
    console.log(
      iconsRestored
        ? `apply-brand-identity: reset ${ICONS_DIR_REL}/ to its committed (stock) state via ` +
          '`git checkout --`.'
        : `apply-brand-identity: could not reset ${ICONS_DIR_REL}/ automatically (no git ` +
          'repository found) -- restore it by hand (e.g. from a fresh checkout) if a brand was ' +
          'ever applied.',
    );
    return;
  }

  if (!args.brandDir) {
    console.error('usage: node scripts/apply-brand-identity.mjs <brand-dir> [--skip-icons]');
    console.error('       node scripts/apply-brand-identity.mjs --reset');
    process.exit(1);
  }

  try {
    applyBrandIdentity({ brandDir: args.brandDir, skipIcons: args.skipIcons });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

// Run when invoked directly, not when imported by tests.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
