/**
 * `modelGeneratesImages.ts` is a hand-written TS mirror of two provider-core
 * tables (`crates/provider-core/src/image_generation.rs`): the
 * `model_generates_images` allowlist and the `default_image_model` per-provider
 * defaults (t0-8 M4). Nothing generates one from the other, so nothing stops
 * them drifting apart one edit at a time -- exactly the gap `modelAcceptsImages.ts`
 * has always had (no test exists for it). This file closes that gap for the
 * image generation mirror rather than repeating it.
 *
 * Two things are checked, for *each* table:
 *  1. Behavioural parity with the Rust unit tests (same cases, same answers).
 *  2. Textual parity: the provider ids (both tables) and model-id substrings
 *     (`model_generates_images`) or exact model ids (`default_image_model`)
 *     literally named in this TS file are extracted and compared against the
 *     ones named in the Rust source -- as sets for `model_generates_images`,
 *     and as a provider→model map (checked in both directions: same provider
 *     ids, and the same model id for every provider named on either side) for
 *     `default_image_model`. Scanned as text against the Rust source because
 *     there is no shared schema between the two languages here -- the only
 *     way to see drift is to look at both sources directly (same approach as
 *     `agentToolsParity.test.ts`).
 *
 *     The `default_image_model` extraction pattern (`case 'x': return 'y';`
 *     in TS, `"x" => Some("y"),` in Rust) deliberately requires the arm to
 *     return a bare quoted string literal. `model_generates_images`'s arms
 *     never do -- they return a boolean expression (`model.includes(...) ||
 *     ...`) -- so the two tables' arms cannot cross-match each other even
 *     though both switch on the same provider ids, and no scoping to a
 *     specific function body is needed.
 *
 * Know what this does NOT catch. The textual scans compare the *shape* of
 * each table -- which providers, which substrings, which default model ids --
 * and catch a change to either side. The behavioural cases below only
 * exercise the TS half. So a *logic* regression made on the Rust side alone
 * (flipping `||` to `&&`, dropping the case-folding, or renaming a default
 * model id to something `model_generates_images` would reject -- the
 * invariant `image_generation.rs`'s own
 * `default_image_model_is_always_recognized_by_model_generates_images` test
 * guards) slips past this file entirely and is caught only by
 * `image_generation.rs`'s own unit tests. Both halves need their tests;
 * neither file is a substitute for the other.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultImageModel, modelGeneratesImages } from './modelGeneratesImages';

const here = dirname(fileURLToPath(import.meta.url));
const tsFile = join(here, 'modelGeneratesImages.ts');
const rustFile = join(here, '..', '..', '..', '..', 'crates', 'provider-core', 'src', 'image_generation.rs');

/** Provider ids named in a `case 'x':` (TS) or `"x" =>` (Rust) match arm. */
function extractProviderIds(src: string, pattern: RegExp): Set<string> {
  const ids = new Set<string>();
  for (const m of src.matchAll(pattern)) {
    ids.add(m[1]);
  }
  return ids;
}

/** Model-id substrings named in a `model.includes('x')` / `model.contains("x")` call. */
function extractNeedles(src: string, pattern: RegExp): Set<string> {
  const needles = new Set<string>();
  for (const m of src.matchAll(pattern)) {
    needles.add(m[1]);
  }
  return needles;
}

/**
 * Provider → default-model-id pairs from a `case 'x': return 'y';` (TS) or
 * `"x" => Some("y"),` (Rust) arm -- see the module doc comment for why this
 * shape only matches `default_image_model`'s arms, never
 * `model_generates_images`'s.
 */
function extractDefaultModelPairs(src: string, pattern: RegExp): Map<string, string> {
  const pairs = new Map<string, string>();
  for (const m of src.matchAll(pattern)) {
    pairs.set(m[1], m[2]);
  }
  return pairs;
}

function sorted(set: Set<string>): string[] {
  return [...set].sort();
}

describe('modelGeneratesImages behavioural parity with provider-core::model_generates_images', () => {
  it('openai image models return true', () => {
    expect(modelGeneratesImages('openai', 'dall-e-3')).toBe(true);
    expect(modelGeneratesImages('openai', 'gpt-image-1')).toBe(true);
  });

  it('gemini imagen models return true', () => {
    expect(modelGeneratesImages('gemini', 'imagen-3.0-generate-002')).toBe(true);
  });

  it('chat models on the same providers return false', () => {
    expect(modelGeneratesImages('openai', 'gpt-4o-mini')).toBe(false);
    expect(modelGeneratesImages('gemini', 'gemini-2.0-flash')).toBe(false);
  });

  it('unknown providers always return false, even with an image-shaped model id', () => {
    expect(modelGeneratesImages('anthropic', 'claude-sonnet-4')).toBe(false);
    expect(modelGeneratesImages('ollama', 'dall-e-3')).toBe(false);
    expect(modelGeneratesImages('made-up-provider', 'imagen-3')).toBe(false);
  });

  it('matching is case-insensitive on both provider id and model id', () => {
    expect(modelGeneratesImages('OpenAI', 'DALL-E-3')).toBe(true);
    expect(modelGeneratesImages('GEMINI', 'IMAGEN-3.0-GENERATE-002')).toBe(true);
    expect(modelGeneratesImages('openai', 'GPT-IMAGE-1')).toBe(true);
  });
});

describe('defaultImageModel behavioural parity with provider-core::default_image_model', () => {
  it('returns the known default for each generative provider', () => {
    expect(defaultImageModel('openai')).toBe('gpt-image-2.5-sunburst');
    expect(defaultImageModel('gemini')).toBe('imagen-4.0-generate-001');
  });

  it('returns null for providers with no image-generation endpoint', () => {
    expect(defaultImageModel('anthropic')).toBeNull();
    expect(defaultImageModel('ollama')).toBeNull();
    expect(defaultImageModel('made-up-provider')).toBeNull();
  });

  it('matching is case-insensitive on the provider id', () => {
    expect(defaultImageModel('OpenAI')).toBe('gpt-image-2.5-sunburst');
    expect(defaultImageModel('GEMINI')).toBe('imagen-4.0-generate-001');
  });

  it('every default it returns is itself accepted by modelGeneratesImages', () => {
    for (const provider of ['openai', 'gemini', 'anthropic', 'ollama', 'made-up-provider']) {
      const model = defaultImageModel(provider);
      if (model != null) {
        expect(
          modelGeneratesImages(provider, model),
          `defaultImageModel(${provider}) = ${model} but modelGeneratesImages(${provider}, ${model}) is false`,
        ).toBe(true);
      }
    }
  });
});

describe('modelGeneratesImages textual parity with the Rust allowlist (drift guard)', () => {
  const tsSrc = readFileSync(tsFile, 'utf8');
  const rustSrc = readFileSync(rustFile, 'utf8');

  const tsProviders = extractProviderIds(tsSrc, /case '([a-z_]+)':/g);
  const rustProviders = extractProviderIds(rustSrc, /"([a-z_]+)"\s*=>/g);

  const tsNeedles = extractNeedles(tsSrc, /model\.includes\('([^']+)'\)/g);
  const rustNeedles = extractNeedles(rustSrc, /model\.contains\("([^"]+)"\)/g);

  it('found at least one provider id and one needle in each source (the parser did not silently break)', () => {
    expect(tsProviders.size).toBeGreaterThan(0);
    expect(rustProviders.size).toBeGreaterThan(0);
    expect(tsNeedles.size).toBeGreaterThan(0);
    expect(rustNeedles.size).toBeGreaterThan(0);
  });

  it('names exactly the same provider ids as the Rust allowlist', () => {
    expect(
      sorted(tsProviders),
      `Provider ids drifted between modelGeneratesImages.ts (${sorted(tsProviders).join(', ')}) ` +
        `and image_generation.rs (${sorted(rustProviders).join(', ')})`,
    ).toEqual(sorted(rustProviders));
  });

  it('names exactly the same model-id substrings as the Rust allowlist', () => {
    expect(
      sorted(tsNeedles),
      `Model-id substrings drifted between modelGeneratesImages.ts (${sorted(tsNeedles).join(', ')}) ` +
        `and image_generation.rs (${sorted(rustNeedles).join(', ')})`,
    ).toEqual(sorted(rustNeedles));
  });
});

describe('defaultImageModel textual parity with the Rust default table (drift guard)', () => {
  const tsSrc = readFileSync(tsFile, 'utf8');
  const rustSrc = readFileSync(rustFile, 'utf8');

  const tsDefaults = extractDefaultModelPairs(tsSrc, /case '([a-z_]+)':\s*return '([^']+)';/g);
  const rustDefaults = extractDefaultModelPairs(rustSrc, /"([a-z_]+)"\s*=>\s*Some\("([^"]+)"\),/g);

  it('found at least one default-model pair in each source (the parser did not silently break)', () => {
    expect(tsDefaults.size).toBeGreaterThan(0);
    expect(rustDefaults.size).toBeGreaterThan(0);
  });

  it('names exactly the same provider ids in the default-model table as the Rust source', () => {
    const tsProviders = sorted(new Set(tsDefaults.keys()));
    const rustProviders = sorted(new Set(rustDefaults.keys()));
    expect(
      tsProviders,
      `default_image_model provider ids drifted between modelGeneratesImages.ts (${tsProviders.join(', ')}) ` +
        `and image_generation.rs (${rustProviders.join(', ')})`,
    ).toEqual(rustProviders);
  });

  it('names exactly the same default model id, for every provider named on either side', () => {
    const allProviders = sorted(new Set([...tsDefaults.keys(), ...rustDefaults.keys()]));
    const drifted: string[] = [];
    for (const provider of allProviders) {
      const tsModel = tsDefaults.get(provider);
      const rustModel = rustDefaults.get(provider);
      if (tsModel !== rustModel) {
        drifted.push(
          `${provider}: modelGeneratesImages.ts says ${tsModel ?? '(not present)'}, ` +
            `image_generation.rs says ${rustModel ?? '(not present)'}`,
        );
      }
    }
    expect(drifted, `default_image_model values drifted:\n${drifted.join('\n')}`).toEqual([]);
  });
});
