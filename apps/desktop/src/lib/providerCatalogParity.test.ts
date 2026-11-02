/**
 * Every provider in provider-core's catalog has its renderer-side names.
 *
 * Adding an OpenAI-compatible preset touches Rust (constructor, registry,
 * descriptor; the catalog's parity tests keep those three in step) and two
 * lists here: `DISPLAY_NAMES` (how a chat names the provider) and
 * `FALLBACK_PROVIDER_BRANDS` (the provider picker before the descriptors
 * load). Nothing else would notice a forgotten entry: the provider just shows
 * as "Cerebras" spelled from its id, or is missing from the picker's first
 * paint. This reads the Rust catalog as text and checks both lists.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FALLBACK_PROVIDER_BRANDS } from '../workspace/settings/ProviderPicker';
import { DISPLAY_NAMES } from './providerIdentity';

const catalog = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'crates', 'provider-core', 'src', 'catalog.rs'),
  'utf8',
);

/** `id` and `display_name` of each `ProviderDescriptor` in `PROVIDER_DESCRIPTORS`. */
const descriptors = [...catalog.matchAll(/ProviderDescriptor \{\s*id: "([^"]+)",\s*display_name: "([^"]+)"/g)].map(
  ([, id, displayName]) => ({ id, displayName }),
);

describe('provider catalog parity', () => {
  it('reads the catalog', () => {
    expect(descriptors.length).toBeGreaterThan(20);
    expect(descriptors.map((d) => d.id)).toContain('openrouter');
  });

  it('names every catalog provider the way the catalog does', () => {
    const missing = descriptors.filter((d) => DISPLAY_NAMES[d.id] === undefined).map((d) => d.id);
    expect(missing).toEqual([]);
  });

  it('lists every named provider in the picker fallback', () => {
    const listed = new Set(FALLBACK_PROVIDER_BRANDS.map((b) => b.id));
    // "OpenAI-compatible" is prose, rendered from the message catalog instead.
    const missing = descriptors.filter((d) => d.id !== 'openai_compat' && !listed.has(d.id)).map((d) => d.id);
    expect(missing).toEqual([]);
  });
});
