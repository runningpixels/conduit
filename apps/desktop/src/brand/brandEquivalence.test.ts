/**
 * The acceptance test for the whole two-mode white-label design
 * (`docs/private/white-label-plan.md` §5-6, "Equivalence (the important
 * one)"): the SAME `brand.md` must produce the same computed CSS
 * custom-property values through Mode A's runtime apply path
 * (`applyBrand.ts`'s `PALETTE_PROPERTY_MAP` + `deriveHueWeak`) and Mode B's
 * build-time emitter (`cargo run --example apply_brand -p provider-core`,
 * `crates/provider-core/src/brand_emit.rs`). If they can diverge, a demo
 * stops predicting what ships, which is the entire point of the two modes
 * sharing one format.
 *
 * This runs the REAL `apply_brand` example as a child process rather than
 * re-implementing its CSS generation in TypeScript — a second
 * implementation is exactly the kind of drift this test exists to catch,
 * just moved one level up. Its output is written into a scratch
 * `--repo-root` (a fresh temp directory), never into this repo's own
 * `packages/ui/src/brand.generated.css` / `apps/desktop/src/brand/generated.ts`
 * — this test must not perturb either a developer's working tree or another
 * suite's fixtures.
 *
 * The expected values are read out of the SAME `brand.md` fixture with a
 * tiny ad hoc TOML-table extractor (`extractPalette` below), rather than a
 * second, hand-duplicated set of hex literals in this file: a duplicated
 * fixture is exactly the two-sources-of-truth problem this test exists to
 * guard against, just moved into the test itself instead of the product.
 *
 * Invokes `cargo`, so it needs a Rust toolchain on PATH and a (possibly
 * cold) compile of `provider-core` — the generous `timeout` below accounts
 * for that; a warm build completes in well under a second.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrandPalette } from '@conduit/config-schema';
import { PALETTE_PROPERTY_MAP } from './applyBrand';
import { extractRule, resolve, type CascadeElement, type CascadeRule } from './miniCascade';

const here = dirname(fileURLToPath(import.meta.url));
// apps/desktop/src/brand -> repo root
const repoRoot = join(here, '..', '..', '..', '..');
const fixtureDir = join(here, '__fixtures__', 'equivalence-brand');
const brandMdPath = join(fixtureDir, 'brand.md');
const tokensCssPath = join(repoRoot, 'packages', 'ui', 'src', 'tokens.css');

/** Mirrors `applyBrand.ts`'s `deriveHueWeak` exactly -- imported by name
 * would be cleaner, but that function is not exported (deliberately: it is
 * an internal derivation step, not part of the module's public apply
 * surface), so this is copied verbatim. If the two ever disagree, that is
 * itself exactly the kind of drift this suite exists to catch -- keep this
 * in sync with `applyBrand.ts` if that template ever changes. */
function deriveHueWeak(hue: string): string {
  return `color-mix(in srgb, ${hue} 14%, transparent)`;
}

/**
 * Pull `key = "value"` pairs out of one `[section]` TOML table in raw text.
 * Not a general TOML parser -- just enough for this fixture's flat,
 * string-valued, single-line tables, stopping at the next top-level `[`
 * header or end of input.
 */
function extractSection(toml: string, section: string): Record<string, string> {
  const escaped = section.replace(/\./g, '\\.');
  const headerRe = new RegExp(`^\\[${escaped}\\]\\s*$`, 'm');
  const m = headerRe.exec(toml);
  if (!m) throw new Error(`fixture brand.md has no [${section}] table`);
  const rest = toml.slice(m.index + m[0].length);
  const nextHeaderIdx = rest.search(/^\[/m);
  const body = nextHeaderIdx === -1 ? rest : rest.slice(0, nextHeaderIdx);

  const out: Record<string, string> = {};
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/.exec(trimmed);
    if (kv) out[kv[1]] = kv[2];
  }
  return out;
}

function extractPalette(toml: string, theme: 'dark' | 'light'): BrandPalette {
  const fields = extractSection(toml, `palette.${theme}`);
  const missing = (Object.keys(PALETTE_PROPERTY_MAP) as (keyof BrandPalette)[]).filter(
    (k) => !(k in fields),
  );
  expect(missing, `fixture [palette.${theme}] is missing keys`).toEqual([]);
  return fields as unknown as BrandPalette;
}

/** Every `--custom-property: value;` declaration inside one `{ ... }` block
 * whose opening selector line matches `selectorNeedle` exactly. */
function extractBlockDeclarations(css: string, selectorLine: string): Record<string, string> {
  const idx = css.indexOf(`${selectorLine} {`);
  expect(idx, `no \`${selectorLine} {\` block found in generated CSS:\n${css}`).toBeGreaterThanOrEqual(0);
  const bodyStart = css.indexOf('{', idx) + 1;
  const bodyEnd = css.indexOf('\n}', bodyStart);
  const body = css.slice(bodyStart, bodyEnd);

  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

describe('Mode A / Mode B equivalence (white-label plan §6)', () => {
  const source = readFileSync(brandMdPath, 'utf8');
  const darkFixture = extractPalette(source, 'dark');
  const lightFixture = extractPalette(source, 'light');

  // Real rules extracted straight off `tokens.css` -- not hand-copied --
  // for the descendant-resolution tests below (white-label plan §5-6, the
  // bug where a message bubble / model-picker row / sidebar chip keeps its
  // provider's own hardcoded hue because it independently carries its own
  // `[data-provider]` attribute, which custom-property inheritance treats
  // as a closer declaration than anything the root sets, no matter how
  // specific the root's own rule is). If either rule's selector or
  // declarations ever change shape, these `extractRule` calls fail loudly
  // (wrong anchor text, or a missing declaration) rather than silently
  // testing stale text.
  const tokensCss = readFileSync(tokensCssPath, 'utf8');
  const anthropicProviderRule = extractRule(tokensCss, '[data-provider="anthropic"]');
  const modeANeutralizeRule = extractRule(tokensCss, 'html[data-palette="brand"] [data-provider]');

  let outDir: string;
  let generatedCss: string;

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), 'conduit-brand-equivalence-'));
    execFileSync(
      'cargo',
      ['run', '--example', 'apply_brand', '-p', 'provider-core', '--', fixtureDir, '--repo-root', outDir],
      { cwd: repoRoot, stdio: 'pipe' },
    );
    generatedCss = readFileSync(join(outDir, 'packages', 'ui', 'src', 'brand.generated.css'), 'utf8');
  }, 180_000);

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  const paletteKeys = Object.keys(PALETTE_PROPERTY_MAP) as (keyof BrandPalette)[];

  it.each([
    ['dark', ':root:root', () => darkFixture] as const,
    ['light', ':root:root[data-theme="light"]', () => lightFixture] as const,
  ])('%s: every PALETTE_PROPERTY_MAP property matches the emitted value', (_theme, selector, getFixture) => {
    const fixture = getFixture();
    const declared = extractBlockDeclarations(generatedCss, selector);

    for (const key of paletteKeys) {
      const prop = PALETTE_PROPERTY_MAP[key];
      expect(declared[prop], `${selector} ${prop} (from BrandPalette.${key})`).toBe(fixture[key]);
    }
  });

  it.each([
    ['dark', ':root:root', () => darkFixture] as const,
    ['light', ':root:root[data-theme="light"]', () => lightFixture] as const,
  ])('%s: --hue-weak matches deriveHueWeak(hue)', (_theme, selector, getFixture) => {
    const fixture = getFixture();
    const declared = extractBlockDeclarations(generatedCss, selector);
    expect(declared['--hue-weak']).toBe(deriveHueWeak(fixture.hue));
  });

  /**
   * The symmetric half of "fail loudly if someone adds a palette key to one
   * side only": the assertions above only check that every TS-side property
   * is present and correct in the emitted CSS. This checks the reverse --
   * that the emitted CSS declares no *extra* custom property beyond the
   * known set, which is what would catch a key added to the Rust emitter
   * (`palette_css_pairs` in `brand_emit.rs`) without a matching addition to
   * `PALETTE_PROPERTY_MAP` here.
   */
  it.each([
    ['dark', ':root:root'] as const,
    ['light', ':root:root[data-theme="light"]'] as const,
  ])('%s: emits no custom property outside the known set', (_theme, selector) => {
    const declared = extractBlockDeclarations(generatedCss, selector);
    const known = new Set<string>([...Object.values(PALETTE_PROPERTY_MAP), '--hue-weak']);
    const extra = Object.keys(declared).filter((prop) => !known.has(prop));
    expect(extra, `unexpected custom propert(y/ies) in ${selector}`).toEqual([]);
  });

  /**
   * The gap the coordinator's review caught: the assertions above only ever
   * check the ROOT (`:root:root`). `tokens.css`'s `[data-provider="..."]`
   * blocks match ANY element carrying that attribute, not only `<html>` --
   * `AssistantMessage.tsx`, `ChatView.tsx`, `ComposerModelPicker.tsx` and
   * `Sidebar.tsx` all set their own `data-provider` independently, on
   * message bubbles, model-picker rows and sidebar chips. A root-only test
   * cannot see that a descendant keeps its own provider colour instead of
   * tracking the brand -- which is exactly the bug that shipped. These
   * tests compute the ACTUAL resolved value for a descendant element (via
   * `miniCascade.ts`, since jsdom's `getComputedStyle` does not resolve
   * `var()` or custom-property inheritance at all -- verified by hand) for
   * both modes, using rules extracted from the real `tokens.css` and the
   * real emitted `brand.generated.css`, not hand-asserted expectations.
   */
  describe('provider-hue neutralization reaches a descendant element', () => {
    // AssistantMessage.tsx:162 / ChatView.tsx:1242 / ComposerModelPicker.tsx:243 /
    // Sidebar.tsx:293 all render roughly this shape: <html data-provider="...">
    // ... <div data-provider="..."> (the bubble/row/chip). "anthropic" here
    // matches the fixture's use of tokens.css's real anthropic provider rule.
    const descendant: CascadeElement = { tag: 'div', attrs: { 'data-provider': 'anthropic' } };

    it('Mode A: the descendant resolves to the brand hue, not the provider literal', () => {
      const htmlEl: CascadeElement = {
        tag: 'html',
        attrs: { 'data-palette': 'brand', 'data-provider': 'anthropic' },
      };
      const rules: CascadeRule[] = [anthropicProviderRule, modeANeutralizeRule];
      // Mode A's applyBrandTheme: setProperty(...) on <html> is an inline
      // style, modeled here as rootInline rather than a selector-based rule.
      const rootInline = {
        '--hue': darkFixture.hue,
        '--hue-text': darkFixture.hueText,
        '--hue-solid': darkFixture.hueSolid,
        '--hue-weak': `color-mix(in srgb, ${darkFixture.hue} 14%, transparent)`,
      };

      expect(resolve(rules, [htmlEl, descendant], '--hue', { rootInline })).toBe(darkFixture.hue);
      expect(resolve(rules, [htmlEl, descendant], '--hue-weak', { rootInline })).toBe(rootInline['--hue-weak']);

      // Sanity: this is a real assertion, not a tautology -- without the
      // neutralization rule, the descendant keeps the provider's own
      // literal instead, which is the bug this whole test exists to catch.
      const withoutFix = resolve([anthropicProviderRule], [htmlEl, descendant], '--hue', { rootInline });
      expect(withoutFix).toBe(anthropicProviderRule.declarations['--hue']);
      expect(withoutFix).not.toBe(darkFixture.hue);
    });

    it('Mode B: the descendant resolves to the brand hue, not the provider literal', () => {
      // Mode B has no runtime `data-palette="brand"` toggle -- its
      // neutralization rule is unconditional (see brand_emit.rs).
      const htmlEl: CascadeElement = { tag: 'html', attrs: { 'data-provider': 'anthropic' } };
      const modeBDarkRule: CascadeRule = { selector: ':root:root', declarations: darkDeclarationsFor(':root:root') };
      const modeBNeutralizeRule = extractRule(generatedCss, ':root:root [data-provider]');
      const rules: CascadeRule[] = [modeBDarkRule, anthropicProviderRule, modeBNeutralizeRule];

      expect(resolve(rules, [htmlEl, descendant], '--hue')).toBe(darkFixture.hue);
      expect(resolve(rules, [htmlEl, descendant], '--hue-weak')).toBe(
        `color-mix(in srgb, ${darkFixture.hue} 14%, transparent)`,
      );

      const withoutFix = resolve([modeBDarkRule, anthropicProviderRule], [htmlEl, descendant], '--hue');
      expect(withoutFix).toBe(anthropicProviderRule.declarations['--hue']);
      expect(withoutFix).not.toBe(darkFixture.hue);
    });

    it('Mode A and Mode B resolve the SAME descendant --hue -- the equivalence this whole suite exists to protect', () => {
      const htmlA: CascadeElement = {
        tag: 'html',
        attrs: { 'data-palette': 'brand', 'data-provider': 'anthropic' },
      };
      const htmlB: CascadeElement = { tag: 'html', attrs: { 'data-provider': 'anthropic' } };
      const rootInline = { '--hue': darkFixture.hue };

      const modeAResult = resolve([anthropicProviderRule, modeANeutralizeRule], [htmlA, descendant], '--hue', {
        rootInline,
      });

      const modeBDarkRule: CascadeRule = { selector: ':root:root', declarations: darkDeclarationsFor(':root:root') };
      const modeBNeutralizeRule = extractRule(generatedCss, ':root:root [data-provider]');
      const modeBResult = resolve(
        [modeBDarkRule, anthropicProviderRule, modeBNeutralizeRule],
        [htmlB, descendant],
        '--hue',
      );

      expect(modeAResult).toBe(modeBResult);
    });

    function darkDeclarationsFor(selector: string): Record<string, string> {
      return extractBlockDeclarations(generatedCss, selector);
    }
  });
});
