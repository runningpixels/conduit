import { describe, expect, it } from 'vitest';
import { providerDisplayName, providerHueId } from './providerIdentity';

describe('providerHueId', () => {
  it('maps the three hue-bearing adapters to their own identity', () => {
    expect(providerHueId('anthropic')).toBe('anthropic');
    expect(providerHueId('openai')).toBe('openai');
    expect(providerHueId('ollama')).toBe('ollama');
  });

  it('maps every other registered adapter id to custom', () => {
    // Ids present in provider_core::adapter::registry() / catalog.rs
    for (const id of ['gemini', 'openrouter', 'opencode_zen', 'lmstudio']) {
      expect(providerHueId(id)).toBe('custom');
    }
    // Adapter classes that delegate their id to an inner adapter
    for (const id of ['openai_compat', 'openai_preset', 'groq', 'deepseek', 'mistral']) {
      expect(providerHueId(id)).toBe('custom');
    }
  });

  it('falls back to custom for unknown and empty ids', () => {
    expect(providerHueId('totally-unknown-provider')).toBe('custom');
    expect(providerHueId('')).toBe('custom');
  });
});

describe('providerDisplayName', () => {
  it('returns friendly names for known adapter ids', () => {
    expect(providerDisplayName('anthropic')).toBe('Anthropic');
    expect(providerDisplayName('openai')).toBe('OpenAI');
    expect(providerDisplayName('ollama')).toBe('Ollama');
    expect(providerDisplayName('gemini')).toBe('Gemini');
    expect(providerDisplayName('opencode_zen')).toBe('OpenCode');
    expect(providerDisplayName('lmstudio')).toBe('LM Studio');
  });

  it('capitalizes the id when unknown and handles empty input', () => {
    expect(providerDisplayName('some-custom-adapter')).toBe('Some-custom-adapter');
    expect(providerDisplayName('')).toBe('Custom');
  });
});
