#!/usr/bin/env node
// Run CI's `verify` job locally, so a push doesn't fail on something a
// machine here could have caught.
//
//   pnpm verify          every step of .github/workflows/ci.yml's verify job
//   pnpm verify:fast     the quick gates: format, Clippy, schema freshness,
//                        typecheck (no tests) — what the pre-push hook runs
//
// Steps run in CI's order and stop at the first failure. The list below is
// checked against ci.yml on every run: if CI gains a step this script doesn't
// know, it says so, so the two can't quietly drift apart.
//
// Windows notes, both from real failures:
// - A running `pnpm dev` app locks target/debug/conduit-desktop.exe. When one
//   is up, Rust steps build into target/alt instead — always that one
//   directory, never a new one per run (per-run dirs once filled 250 GB).
// - Line endings: schema freshness ignores CR-only differences, which Git on
//   Windows reports for regenerated files even when nothing changed.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fast = process.argv.includes('--fast');
const isWindows = process.platform === 'win32';

/** CI step name → how to run it here. `fast` steps also run in --fast. */
const STEPS = [
  {
    ci: 'Localized README drift',
    // CI marks this warn-only (continue-on-error); so does this script.
    warnOnly: true,
    cmd: ['node', 'scripts/readme-i18n.mjs', '--check'],
  },
  { ci: 'Format check', fast: true, cmd: ['cargo', 'fmt', '--all', '--check'] },
  {
    ci: 'Clippy',
    fast: true,
    cmd: ['cargo', 'clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'],
  },
  { ci: 'Rust tests', cmd: ['cargo', 'test', '--workspace'] },
  {
    ci: 'WebKitGTK WebRTC switch (Linux)',
    linuxOnly: true,
    cmd: ['xvfb-run', '-a', 'cargo', 'test', '-p', 'conduit-desktop', '--test', 'webkit_webrtc_linux', '--', '--ignored', '--nocapture'],
  },
  {
    ci: 'Dependency audit (cargo-deny)',
    optionalTool: 'cargo-deny',
    cmd: ['cargo', 'deny', 'check', 'advisories', 'licenses', 'bans', 'sources'],
  },
  {
    ci: 'Regenerate schema bindings',
    fast: true,
    cmd: ['cargo', 'run', '--quiet', '--example', 'export_ts', '-p', 'provider-core'],
  },
  {
    ci: 'Schema freshness',
    fast: true,
    // core.safecrlf=false: without it Git prints an LF/CRLF warning per file on Windows.
    cmd: ['git', '-c', 'core.safecrlf=false', 'diff', '--ignore-cr-at-eol', '--exit-code', '--', 'packages/config-schema/src/generated'],
    hint: 'The Rust schema changed: commit the regenerated packages/config-schema/src/generated files.',
  },
  { ci: 'Renderer typecheck', fast: true, cwd: 'apps/desktop', cmd: ['pnpm', 'run', 'check'] },
  { ci: 'Renderer tests (vitest)', cwd: 'apps/desktop', cmd: ['pnpm', 'test'] },
];

/** CI steps that only set up the runner and have no local equivalent. */
const CI_SETUP_ONLY = new Set([
  'Free disk space',
  'Install Tauri system dependencies (Linux)',
  'Install Rust toolchain',
  'Rust cache',
  'Install pnpm',
  'Install Node',
  'Install JS dependencies',
  'Disk space after Rust tests',
]);

const color = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => color(1, s);
const red = (s) => color(31, s);
const green = (s) => color(32, s);
const yellow = (s) => color(33, s);

/** Step names of ci.yml's `verify` job, read without a YAML dependency. */
function ciVerifySteps() {
  const yml = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const start = yml.search(/^ {2}verify:\s*$/m);
  if (start < 0) return null;
  const rest = yml.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  const job = next < 0 ? rest : rest.slice(0, next);
  return [...job.matchAll(/^\s+- name:\s*(.+?)\s*$/gm)].map((m) => m[1].replace(/^['"]|['"]$/g, ''));
}

function checkDrift() {
  const ci = ciVerifySteps();
  if (!ci) {
    console.log(yellow('! Could not find the verify job in ci.yml — steps not cross-checked.'));
    return;
  }
  const known = new Set(STEPS.map((s) => s.ci));
  const missing = ci.filter((name) => !known.has(name) && !CI_SETUP_ONLY.has(name));
  for (const name of missing) {
    console.log(yellow(`! CI runs "${name}", which scripts/verify.mjs doesn't mirror yet. Add it.`));
  }
}

/** Is a `pnpm dev` build of the app running (and so locking target/debug)? */
function devAppRunning() {
  if (!isWindows) return false;
  const r = spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    "Get-Process conduit-desktop -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*\\target\\debug\\*' } | Measure-Object | % Count",
  ], { encoding: 'utf8' });
  return Number((r.stdout || '0').trim()) > 0;
}

function hasTool(name) {
  const r = spawnSync(isWindows ? 'where' : 'which', [name], { encoding: 'utf8' });
  return r.status === 0;
}

function run(step, env) {
  const started = Date.now();
  const opts = { cwd: join(root, step.cwd ?? '.'), env, stdio: 'inherit' };
  // pnpm is a .cmd shim on Windows, so it needs a shell; pass one command
  // string (every argument here is a plain word) rather than args + shell.
  const r = isWindows
    ? spawnSync(step.cmd.join(' '), { ...opts, shell: true })
    : spawnSync(step.cmd[0], step.cmd.slice(1), opts);
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  return { ok: r.status === 0, secs };
}

const env = { ...process.env };
if (!env.CARGO_TARGET_DIR && devAppRunning()) {
  env.CARGO_TARGET_DIR = join(root, 'target', 'alt');
  console.log(yellow('The dev app is running, so Rust steps build into target/alt (delete it when done).'));
}

checkDrift();
const steps = STEPS.filter((s) => !fast || s.fast);
console.log(bold(`\nverify${fast ? ' --fast' : ''}: ${steps.length} step(s), in CI's order\n`));

const results = [];
for (const step of steps) {
  if (step.linuxOnly && process.platform !== 'linux') {
    console.log(yellow(`- ${step.ci}: skipped (Linux only; CI runs it)`));
    results.push([step.ci, 'skipped']);
    continue;
  }
  if (step.optionalTool && !hasTool(step.optionalTool)) {
    console.log(yellow(`- ${step.ci}: skipped (${step.optionalTool} isn't installed: cargo install ${step.optionalTool})`));
    results.push([step.ci, 'skipped']);
    continue;
  }
  console.log(bold(`▶ ${step.ci}`));
  const { ok, secs } = run(step, env);
  if (ok) {
    console.log(green(`✓ ${step.ci} (${secs}s)\n`));
    results.push([step.ci, 'ok']);
  } else if (step.warnOnly) {
    console.log(yellow(`! ${step.ci} failed — warn-only, as in CI (${secs}s)\n`));
    results.push([step.ci, 'warned']);
  } else {
    console.log(red(`✗ ${step.ci} failed (${secs}s)`));
    if (step.hint) console.log(red(`  ${step.hint}`));
    console.log(red(`\nStopped: this would fail CI's "${step.ci}" step.`));
    process.exit(1);
  }
}

console.log(green(bold(`All ${results.filter(([, r]) => r === 'ok').length} step(s) passed.`)));
if (fast) console.log('Tests and the dependency audit were skipped (--fast); run `pnpm verify` before opening a PR.');
