/**
 * Provider identity — single source of the adapter id → data-provider mapping
 * (conduit-v7-design-spec §5.4, §12 "Add src/lib/providerIdentity.ts").
 *
 * The renderer tints the whole app with the active provider's hue via
 * `html[data-provider=...]`. The CSS defines exactly four hue identities
 * (`anthropic`, `openai`, `ollama`, `custom`); every adapter id in
 * `provider_core::adapter::registry()` maps to one of them, with an unknown id
 * falling back to `custom`.
 */

export type ProviderHueId = 'anthropic' | 'openai' | 'ollama' | 'custom';

/** Adapter ids that have a dedicated hue identity. Anything else is `custom`. */
const HUE_IDS: Record<string, ProviderHueId> = {
  anthropic: 'anthropic',
  openai: 'openai',
  ollama: 'ollama',
};

/** Human-readable names for known adapter ids (descriptor ids from provider-core catalog). */
const DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'Ollama',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  opencode_zen: 'OpenCode',
  lmstudio: 'LM Studio',
  openai_compat: 'OpenAI-compatible',
  openai_preset: 'OpenAI preset',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  mistral: 'Mistral',
};

/** Map a provider-core adapter id to one of the four CSS hue identities. */
export function providerHueId(adapterId: string): ProviderHueId {
  if (!adapterId) return 'custom';
  return HUE_IDS[adapterId] ?? 'custom';
}

/** Human-readable provider name; falls back to the id, capitalized. */
export function providerDisplayName(adapterId: string): string {
  if (!adapterId) return 'Custom';
  const known = DISPLAY_NAMES[adapterId];
  if (known) return known;
  return adapterId.charAt(0).toUpperCase() + adapterId.slice(1);
}
