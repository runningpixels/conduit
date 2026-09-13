/**
 * Token discipline guard (theming Phase 1).
 *
 * A look (`html[data-look]`, docs/theming/README.md) restyles the product by
 * retargeting tokens: type scale, radii, elevation, motion. A declaration that
 * spells its value out — `font-size: 13px`, `border-radius: 4px`,
 * `transition: opacity .16s` — is invisible to every look, so one stray literal
 * is a rounded corner inside a square theme. This guard finds those.
 *
 * Custom property definitions (`--fs-prose: 15px`) are the tokens themselves
 * and are always allowed; so are keyframes. Anything else literal must be on
 * the ALLOWED list below, with the reason it cannot be a token.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const repoRoot = join(srcRoot, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (f: string) => relative(repoRoot, f).replace(/\\/g, '/');

/**
 * Literal declarations that are deliberately not tokens. Keyed
 * `path: property: value` (whitespace-collapsed) so a moved line stays allowed
 * but a changed value does not.
 */
const ALLOWED: Record<string, string> = {
  'apps/desktop/src/artifacts/markdown/MermaidBlock.tsx: fontSize: 12px':
    'Mermaid themeVariables: the diagram is rasterised into a standalone blob image, where CSS variables never resolve.',
};

/** Blank comments and keyframes blocks out, keeping newlines so line numbers survive. */
function blank(text: string, re: RegExp): string {
  return text.replace(re, (m) => m.replace(/[^\n]/g, ' '));
}

const KEYFRAMES = /@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g;

interface Finding {
  key: string;
  where: string;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function cssFindings(): Finding[] {
  const files = [
    ...walk(join(srcRoot, 'styles')).filter((f) => f.endsWith('.css')),
    join(repoRoot, 'packages', 'ui', 'src', 'tokens.css'),
  ];
  const out: Finding[] = [];
  const checks: Array<[string, RegExp]> = [
    ['font-size', /^\s*-?\d*\.?\d+(px|rem)\b/],
    ['font', /\d*\.?\d+px/],
    ['border-radius', /\d*\.?\d*[1-9]\d*(px|%)/],
    ['box-shadow', /\d*\.?\d*[1-9]\d*px/],
    // A zero duration (`visibility 0s linear …`) is a step, not motion.
    ['transition', /(^|[\s,])(?!0*\.?0+m?s\b)\d*\.?\d+m?s\b/],
  ];
  for (const f of files) {
    const text = blank(blank(readFileSync(f, 'utf8'), /\/\*[\s\S]*?\*\//g), KEYFRAMES);
    for (const m of text.matchAll(/(?<![-\w])(font-size|font|border-radius|box-shadow|transition)\s*:\s*([^;}]+)/g)) {
      const [, prop, rawValue] = m;
      const value = rawValue.trim().replace(/\s+/g, ' ');
      const check = checks.find(([p]) => p === prop)?.[1];
      if (!check || !check.test(value)) continue;
      out.push({ key: `${rel(f)}: ${prop}: ${value}`, where: `${rel(f)}:${lineOf(text, m.index ?? 0)}` });
    }
  }
  return out;
}

function tsxFindings(): Finding[] {
  const files = walk(srcRoot).filter(
    (f) =>
      /\.(tsx?|jsx?)$/.test(f) &&
      !/\.test\.|\.spec\./.test(f) &&
      !rel(f).startsWith('apps/desktop/src/dev/'),
  );
  const out: Finding[] = [];
  for (const f of files) {
    const text = blank(readFileSync(f, 'utf8'), /\/\*[\s\S]*?\*\//g);
    for (const m of text.matchAll(/\b(fontSize|borderRadius)\s*:\s*(['"`]?)(\d[^'"`,}\n]*)\2/g)) {
      const value = m[3].trim();
      if (/^0(px)?$/.test(value)) continue;
      out.push({ key: `${rel(f)}: ${m[1]}: ${value}`, where: `${rel(f)}:${lineOf(text, m.index ?? 0)}` });
    }
  }
  return out;
}

describe('token discipline', () => {
  it('stylesheets route type, radius, shadow and transition through tokens', () => {
    const offenders = cssFindings()
      .filter((x) => !(x.key in ALLOWED))
      .map((x) => `${x.where}  ${x.key.split(': ').slice(1).join(': ')}`);
    expect(offenders).toEqual([]);
  });

  it('inline React styles route fontSize and borderRadius through tokens', () => {
    const offenders = tsxFindings()
      .filter((x) => !(x.key in ALLOWED))
      .map((x) => `${x.where}  ${x.key.split(': ').slice(1).join(': ')}`);
    expect(offenders).toEqual([]);
  });

  it('every allowlist entry still matches something (no stale exemptions)', () => {
    const live = new Set([...cssFindings(), ...tsxFindings()].map((x) => x.key));
    expect(Object.keys(ALLOWED).filter((k) => !live.has(k))).toEqual([]);
  });
});
