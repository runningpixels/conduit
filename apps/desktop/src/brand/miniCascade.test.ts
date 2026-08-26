/**
 * Self-tests for `miniCascade.ts` -- these exist so `brandEquivalence.test.ts`
 * can trust the resolver it uses to prove the provider-hue neutralization
 * fix reaches a descendant element. A resolver bug there could otherwise
 * hide a real product bug (a false pass) just as easily as it could
 * fabricate a false failure, so the mechanism itself needs its own direct
 * coverage before anything else relies on it.
 */

import { describe, expect, it } from 'vitest';
import { compoundSpecificity, extractRule, parseSelector, resolve, type CascadeElement } from './miniCascade';

describe('miniCascade', () => {
  describe('compoundSpecificity', () => {
    it('counts pseudo-classes', () => {
      expect(compoundSpecificity(':root')).toEqual([1, 0]);
      expect(compoundSpecificity(':root:root')).toEqual([2, 0]);
    });

    it('counts attribute selectors, with and without a value', () => {
      expect(compoundSpecificity('[data-provider]')).toEqual([1, 0]);
      expect(compoundSpecificity('[data-provider="anthropic"]')).toEqual([1, 0]);
      expect(compoundSpecificity('[data-palette="brand"][data-provider]')).toEqual([2, 0]);
    });

    it('counts a type selector', () => {
      expect(compoundSpecificity('html')).toEqual([0, 1]);
      expect(compoundSpecificity('html[data-provider]')).toEqual([1, 1]);
    });

    it('matches every real selector shape this suite depends on', () => {
      // These are the exact specificity tuples the provider-core / tokens.css
      // module comments both derive by hand -- if this ever disagrees with
      // them, one of the two hand-derivations (or this function) is wrong.
      expect(compoundSpecificity(':root:root')).toEqual([2, 0]); // (0,2,0)
      expect(compoundSpecificity('html[data-palette="brand"][data-provider]')).toEqual([2, 1]); // (0,2,1)
      expect(compoundSpecificity('[data-provider="anthropic"]')).toEqual([1, 0]); // (0,1,0)
    });
  });

  describe('parseSelector matching', () => {
    it('matches a single compound against the target element only', () => {
      const { matches } = parseSelector('[data-provider="anthropic"]');
      expect(matches([{ tag: 'div', attrs: { 'data-provider': 'anthropic' } }])).toBe(true);
      expect(matches([{ tag: 'div', attrs: { 'data-provider': 'openai' } }])).toBe(false);
    });

    it('matches a compound selector requiring both a tag and an attribute', () => {
      const { matches } = parseSelector('html[data-palette="brand"][data-provider]');
      expect(matches([{ tag: 'html', attrs: { 'data-palette': 'brand', 'data-provider': 'anthropic' } }])).toBe(
        true,
      );
      expect(matches([{ tag: 'div', attrs: { 'data-palette': 'brand', 'data-provider': 'anthropic' } }])).toBe(
        false,
      );
    });

    it('matches a descendant combinator against any ancestor, not just the direct parent', () => {
      const { matches } = parseSelector('html[data-palette="brand"] [data-provider]');
      const path: CascadeElement[] = [
        { tag: 'html', attrs: { 'data-palette': 'brand' } },
        { tag: 'main', attrs: {} },
        { tag: 'div', attrs: { 'data-provider': 'anthropic' } },
      ];
      expect(matches(path)).toBe(true);
    });

    it('fails a descendant combinator when the required ancestor is absent', () => {
      const { matches } = parseSelector('html[data-palette="brand"] [data-provider]');
      const path: CascadeElement[] = [
        { tag: 'html', attrs: {} }, // no data-palette="brand" here
        { tag: 'div', attrs: { 'data-provider': 'anthropic' } },
      ];
      expect(matches(path)).toBe(false);
    });

    it(':root only matches the html element', () => {
      const { matches } = parseSelector(':root:root');
      expect(matches([{ tag: 'html', attrs: {} }])).toBe(true);
      expect(matches([{ tag: 'div', attrs: {} }])).toBe(false);
    });
  });

  describe('resolve', () => {
    const htmlEl = { tag: 'html', attrs: { 'data-provider': 'anthropic' } };
    const divEl = { tag: 'div', attrs: { 'data-provider': 'anthropic' } };

    it('a plain per-provider rule wins on the element it targets directly', () => {
      const rules = [{ selector: '[data-provider="anthropic"]', declarations: { '--hue': '#d97757' } }];
      expect(resolve(rules, [htmlEl, divEl], '--hue')).toBe('#d97757');
    });

    it('higher specificity wins regardless of source order', () => {
      const rules = [
        { selector: '[data-provider="anthropic"]', declarations: { '--hue': '#d97757' } },
        { selector: 'html[data-provider]', declarations: { '--hue': '#111111' } },
      ];
      expect(resolve(rules, [htmlEl], '--hue')).toBe('#111111');
    });

    it('`inherit` climbs to the parent element', () => {
      const rules = [
        { selector: ':root:root', declarations: { '--hue': '#brand01' } },
        {
          selector: ':root:root [data-provider]',
          declarations: { '--hue': 'inherit' },
        },
        { selector: '[data-provider="anthropic"]', declarations: { '--hue': '#d97757' } },
      ];
      // Without the neutralization rule, the descendant would resolve to the
      // provider's own literal.
      const withoutFix = resolve(
        rules.filter((r) => r.declarations['--hue'] !== 'inherit'),
        [htmlEl, divEl],
        '--hue',
      );
      expect(withoutFix).toBe('#d97757');

      // With it, `inherit` on the [data-provider] element defeats the
      // (0,1,0) provider rule via the (0,3,0) neutralization rule's higher
      // specificity, and the descendant's resolution climbs to <html>,
      // which itself has no directly-matching non-inherit rule other than
      // :root:root, so it lands on the brand's own root value.
      const withFix = resolve(rules, [htmlEl, divEl], '--hue');
      expect(withFix).toBe('#brand01');
    });

    it('REGRESSION: a compound <html> form (not descendant-only) blanks the root instead of fixing the descendant', () => {
      // This is the exact bug an earlier draft of the real neutralization
      // rule shipped with: pairing a compound <html>[data-provider]
      // selector alongside the descendant one, copied uncritically from the
      // Orange Charcoal precedent (whose value is a concrete colour, safe at
      // the root). Since <html> ALWAYS carries data-provider too, the
      // compound alternative also matches <html> itself with higher
      // specificity (0,3,0) than the brand's own `:root:root` rule (0,2,0),
      // forcing --hue to `inherit` at the actual DOM root -- which has no
      // parent, so it resolves to undefined instead of the brand colour.
      const dualFormSelector = ':root:root[data-provider],\n:root:root [data-provider]';
      const buggyRules = [
        { selector: ':root:root', declarations: { '--hue': '#brand01' } },
        { selector: dualFormSelector, declarations: { '--hue': 'inherit' } },
      ];
      expect(resolve(buggyRules, [htmlEl], '--hue')).toBeUndefined();

      // The fixed, descendant-only selector does not have this problem: it
      // requires an ancestor to satisfy `:root:root`, which <html> itself
      // never has, so it simply does not match <html> as a target at all.
      const fixedRules = [
        { selector: ':root:root', declarations: { '--hue': '#brand01' } },
        { selector: ':root:root [data-provider]', declarations: { '--hue': 'inherit' } },
      ];
      expect(resolve(fixedRules, [htmlEl], '--hue')).toBe('#brand01');
    });

    it('no matching rule at all falls through to inheritance from the parent', () => {
      const rules = [{ selector: ':root:root', declarations: { '--hue': '#brand01' } }];
      // divEl matches nothing here (no rule targets [data-provider] at all),
      // so it should inherit from <html> exactly as it would in a real
      // browser, with no explicit `inherit` keyword needed anywhere.
      expect(resolve(rules, [htmlEl, divEl], '--hue')).toBe('#brand01');
    });

    it('returns undefined when nothing sets the property anywhere', () => {
      expect(resolve([], [htmlEl, divEl], '--hue')).toBeUndefined();
    });

    it('an inline root declaration beats every selector-based rule at the root', () => {
      const rules = [{ selector: 'html[data-provider]', declarations: { '--hue': '#111111' } }];
      expect(resolve(rules, [htmlEl], '--hue', { rootInline: { '--hue': '#ffaa00' } })).toBe('#ffaa00');
    });

    it('an inline root declaration reaches a descendant only via inheritance, not directly', () => {
      const rules = [
        {
          selector: 'html[data-palette="brand"] [data-provider]',
          declarations: { '--hue': 'inherit' },
        },
        { selector: '[data-provider="anthropic"]', declarations: { '--hue': '#d97757' } },
      ];
      const path = [{ tag: 'html', attrs: { 'data-palette': 'brand', 'data-provider': 'anthropic' } }, divEl];
      expect(resolve(rules, path, '--hue', { rootInline: { '--hue': '#ffaa00' } })).toBe('#ffaa00');

      // And the inline value itself is unaffected: resolving --hue directly
      // on <html> never matches the descendant-only selector at all (no
      // ancestor exists for it to require), so the inline root value stands.
      expect(resolve(rules, [path[0]], '--hue', { rootInline: { '--hue': '#ffaa00' } })).toBe('#ffaa00');
    });
  });

  describe('extractRule', () => {
    it('extracts a single-line rule', () => {
      const css = '[data-provider="anthropic"] { --hue: #d97757; --hue-text: #e08f75; }';
      const rule = extractRule(css, '[data-provider="anthropic"]');
      expect(rule.selector).toBe('[data-provider="anthropic"]');
      expect(rule.declarations).toEqual({ '--hue': '#d97757', '--hue-text': '#e08f75' });
    });

    it('extracts a multi-line, dual-form selector', () => {
      const css = [
        'html[data-palette="brand"][data-provider],',
        'html[data-palette="brand"] [data-provider] {',
        '  --hue: inherit;',
        '  --hue-weak: inherit;',
        '}',
      ].join('\n');
      const rule = extractRule(css, 'html[data-palette="brand"][data-provider]');
      expect(rule.selector).toBe(
        'html[data-palette="brand"][data-provider],\nhtml[data-palette="brand"] [data-provider]',
      );
      expect(rule.declarations).toEqual({ '--hue': 'inherit', '--hue-weak': 'inherit' });
    });

    it('throws when the anchor text is not found', () => {
      expect(() => extractRule('', '[data-provider]')).toThrow();
    });
  });
});
