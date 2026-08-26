/**
 * A tiny, purpose-built CSS cascade + inheritance resolver -- NOT a general
 * CSS engine. It understands exactly the selector shapes this repo's own
 * hue-identity rules use (`:root`, an optional `html` type selector,
 * `[attr]` / `[attr="value"]` attribute selectors, and the descendant
 * combinator) and exactly one non-literal value (`inherit`). That is enough
 * to genuinely compute what a custom property resolves to for a given
 * element in a given ancestor chain, which `brandEquivalence.test.ts` needs
 * to verify the provider-hue neutralization fix (white-label plan section
 * 5-6) actually reaches a descendant element such as a message bubble.
 *
 * jsdom's own `getComputedStyle` cannot answer this question: it does not
 * resolve `var()` or custom-property inheritance at all (verified by hand
 * against this exact repo's jsdom version -- `getPropertyValue('--x')`
 * returns the raw declaration text, unresolved, and a property using
 * `var(--x)` returns the literal string `var(--x)`). There is also no real
 * browser engine available in this repo (no `playwright`/`puppeteer`), and
 * `postcss`/`css-tree` parse CSS but do not do selector-to-element matching
 * or specificity-based cascade resolution on their own. This file is
 * deliberately small and scoped to the one narrow question the test needs
 * answered, rather than a dependency pulled in to parse arbitrary CSS.
 */

export interface CascadeElement {
  tag: string;
  attrs: Record<string, string>;
}

export interface CascadeRule {
  /** Raw selector list text -- may contain commas and literal newlines,
   * exactly as it appears in the source CSS. */
  selector: string;
  declarations: Record<string, string>;
}

/** [attribute/pseudo-class count, type-selector count] for one compound
 * selector. No ID selectors exist anywhere in this codebase's hue rules, so
 * the ID component of full four-part CSS specificity is always 0 and
 * omitted entirely here. */
type Specificity = readonly [b: number, c: number];

function addSpecificity(a: Specificity, b: Specificity): Specificity {
  return [a[0] + b[0], a[1] + b[1]];
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
}

function parseCompound(compound: string): { tag: string | null; parts: string[] } {
  const tagMatch = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(compound);
  const tag = tagMatch ? tagMatch[0] : null;
  const rest = tag ? compound.slice(tag.length) : compound;
  const parts = Array.from(rest.matchAll(/(:[a-zA-Z-]+|\[[^\]]+\])/g)).map((m) => m[0]);
  return { tag, parts };
}

export function compoundSpecificity(compound: string): Specificity {
  const { tag, parts } = parseCompound(compound);
  return [parts.length, tag ? 1 : 0];
}

function compoundMatches(compound: string, el: CascadeElement): boolean {
  const { tag, parts } = parseCompound(compound);
  if (tag && tag.toLowerCase() !== el.tag.toLowerCase()) return false;
  for (const part of parts) {
    if (part === ':root') {
      if (el.tag.toLowerCase() !== 'html') return false;
      continue;
    }
    const attrMatch = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(part);
    if (!attrMatch) throw new Error(`miniCascade: unsupported selector token ${part}`);
    const [, name, value] = attrMatch;
    const actual = el.attrs[name];
    if (actual === undefined) return false;
    if (value !== undefined && actual !== value) return false;
  }
  return true;
}

interface ParsedSelector {
  specificity: Specificity;
  /** `path` is root-first, target-last. Matches if the rightmost compound
   * matches the target and every remaining compound (right to left) matches
   * SOME ancestor at or before the current search frontier -- i.e. plain
   * descendant-combinator matching. Every real selector these hue rules use
   * is whitespace-only (no `>`), so that is the only combinator supported. */
  matches(path: CascadeElement[]): boolean;
}

export function parseSelector(selector: string): ParsedSelector {
  const compounds = selector.trim().split(/\s+/);
  const specificity = compounds.reduce<Specificity>(
    (acc, c) => addSpecificity(acc, compoundSpecificity(c)),
    [0, 0],
  );

  function matches(path: CascadeElement[]): boolean {
    const target = path[path.length - 1];
    if (!target || !compoundMatches(compounds[compounds.length - 1], target)) return false;
    let frontier = path.length - 1;
    for (let i = compounds.length - 2; i >= 0; i--) {
      let found = -1;
      for (let j = frontier - 1; j >= 0; j--) {
        if (compoundMatches(compounds[i], path[j])) {
          found = j;
          break;
        }
      }
      if (found === -1) return false;
      frontier = found;
    }
    return true;
  }

  return { specificity, matches };
}

interface ParsedRule extends ParsedSelector {
  declarations: Record<string, string>;
}

function parseRules(rules: CascadeRule[]): ParsedRule[] {
  const out: ParsedRule[] = [];
  for (const rule of rules) {
    for (const rawSelector of rule.selector.split(',')) {
      const parsed = parseSelector(rawSelector.replace(/\n/g, ' '));
      out.push({ ...parsed, declarations: rule.declarations });
    }
  }
  return out;
}

export interface ResolveOptions {
  /** Declarations that behave like an inline `style` attribute on the ROOT
   * (first) element of `path` -- i.e. Mode A's
   * `document.documentElement.style.setProperty(...)`. Inline styles beat
   * every selector-based rule unconditionally, but (unlike a stylesheet
   * rule) apply to exactly the one element they were set on; they
   * participate in inheritance the same as any other declaration once a
   * descendant's own resolution climbs to the root and finds nothing there
   * but `inherit` or no matching rule. */
  rootInline?: Record<string, string>;
}

/**
 * Resolve `prop`'s computed value for the LAST element of `path` (root
 * first), given `rules` in source order. Custom properties inherit by
 * default, so "no rule matches at this element" and "the winning rule's
 * value is the literal `inherit`" are treated identically: walk up to the
 * parent and try again. Returns `undefined` if the property is unset all
 * the way to the root.
 */
export function resolve(
  rules: CascadeRule[],
  path: CascadeElement[],
  prop: string,
  options: ResolveOptions = {},
): string | undefined {
  const parsed = parseRules(rules);

  function resolveAt(depth: number): string | undefined {
    if (depth === 0 && options.rootInline && prop in options.rootInline) {
      return options.rootInline[prop];
    }

    const subPath = path.slice(0, depth + 1);
    let winner: { specificity: Specificity; value: string } | undefined;
    for (const rule of parsed) {
      const value = rule.declarations[prop];
      if (value === undefined) continue;
      if (!rule.matches(subPath)) continue;
      if (!winner || compareSpecificity(rule.specificity, winner.specificity) >= 0) {
        winner = { specificity: rule.specificity, value };
      }
    }

    if (!winner || winner.value === 'inherit') {
      return depth === 0 ? undefined : resolveAt(depth - 1);
    }
    return winner.value;
  }

  return resolveAt(path.length - 1);
}

/**
 * Extract one rule's full selector text and `--prop: value;` declarations
 * out of raw CSS, anchored on `selectorStart` (the beginning of the
 * selector text -- e.g. `[data-provider="anthropic"]` or
 * `html[data-palette="brand"][data-provider]`) rather than a full selector
 * string, so it does not need to reproduce the source file's exact
 * line-wrapping/whitespace to find the rule. Scans structurally from there
 * (to the first `{`, then to the matching `}` -- none of these rules ever
 * nest braces) rather than depending on any particular formatting.
 */
export function extractRule(css: string, selectorStart: string): CascadeRule {
  const idx = css.indexOf(selectorStart);
  if (idx === -1) throw new Error(`miniCascade.extractRule: ${selectorStart} not found`);
  const braceIdx = css.indexOf('{', idx);
  const selector = css.slice(idx, braceIdx).trim();
  const bodyEnd = css.indexOf('}', braceIdx);
  const body = css.slice(braceIdx + 1, bodyEnd);

  const declarations: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
    declarations[m[1]] = m[2].trim();
  }
  return { selector, declarations };
}
