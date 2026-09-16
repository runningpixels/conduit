/**
 * `modelGeneratesImages.ts` is a hand-written TS mirror of provider-core's
 * `model_generates_images` (`crates/provider-core/src/image_generation.rs`).
 * Nothing generates one from the other, so nothing stops them drifting apart
 * one edit at a time -- exactly the gap `modelAcceptsImages.ts` has always
 * had (no test exists for it). This file closes that gap for the image
 * generation mirror rather than repeating it.
 *
 * Two things are checked:
 *  1. Behavioural parity with the Rust unit tests (same cases, same answers).
 *  2. Textual parity: the provider ids and model-id substrings literally
 *     named in this TS file are extracted and compared, as sets, against the
 *     ones named in the Rust source. Scanned as text against the Rust source
 *     because there is no shared schema between the two languages here --
 *     the only way to see drift is to look at both sources directly (same
 *     approach as `agentToolsParity.test.ts`).
 *
 * Know what this does NOT catch. The textual scan compares the *shape* of the
 * allowlist -- which providers, which substrings -- and catches a change to
 * either side. The behavioural cases below only exercise the TS half. So a
 * *logic* regression made on the Rust side alone (flipping `||` to `&&`, or
 * dropping the case-folding) slips past this file entirely and is caught only
 * by `image_generation.rs`'s own unit tests. Both halves need their tests;
 * neither file is a substitute for the other.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { modelGeneratesImages } from './modelGeneratesImages';

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
