/**
 * The type scale (design polish, 2026-10): nothing a person reads is set under
 * 12px, and every size follows Settings → Appearance → UI font size.
 *
 * Before this, the scale ran down to 10px and the setting multiplied only the
 * body's base size, so the 600-odd rules that name a size ignored it. Both are
 * read from tokens.css itself, so a new token or an edited one re-checks.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(
  join(here, '..', '..', '..', '..', 'packages', 'ui', 'src', 'tokens.css'),
  'utf8',
).replace(/\r\n/g, '\n');

/** Every `--fs-*` size declared in tokens.css, except the scale factor itself. */
const sizes = [...tokens.matchAll(/--(fs-[a-z0-9-]+):\s*([^;]+);/g)]
  .filter(([, name]) => name !== 'fs-scale')
  .map(([, name, value]) => [name, value.trim()] as const);

/** The pixel sizes a declaration names: `max(12px, calc(12.5px * …))` → [12, 12.5]. */
function pixels(value: string): number[] {
  return [...value.matchAll(/([0-9.]+)px/g)].map((m) => Number(m[1]));
}

describe('type scale', () => {
  it('declares the sizes', () => {
    expect(sizes.length).toBeGreaterThan(10);
  });

  it.each(sizes)('--%s is at least 12px', (_name, value) => {
    for (const px of pixels(value)) expect(px).toBeGreaterThanOrEqual(12);
  });

  it.each(sizes)('--%s follows the UI font size setting', (_name, value) => {
    expect(value).toMatch(/var\(--fs-scale\)/);
  });

  it('small sizes keep the 12px floor even at Compact', () => {
    for (const [, value] of sizes) {
      if (Math.min(...pixels(value)) <= 13) expect(value).toMatch(/^max\(12px,/);
    }
  });

  it('the body does not scale a second time', () => {
    expect(tokens).not.toMatch(/font-size:\s*calc\(var\(--fs-[a-z0-9]+\)\s*\*\s*var\(--fs-scale/);
  });
});
