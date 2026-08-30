import type { ProviderEndpointConfig, WebSearchMode } from '@conduit/config-schema';

/** Heuristic: does the user's message ask for live / internet information?
 *  Used to auto-opt-in to web search when globally enabled but the per-turn
 *  ⌕ toggle was left off — a common miss because the toggle defaults off. */
export function userWantsWebSearch(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  return /\b(search the (internet|web)|search online|look up online|search for|latest .{0,40}(news|market|headlines)|current .{0,40}(news|events|market)|this week'?s .{0,40}(news|market)|today'?s .{0,40}(news|market)|on the internet|from the web)\b/i.test(
    text,
  );
}

/** Whether web search should be active for this send. */
export function resolveWebSearchForTurn(
  settings: { webSearchEnabled: boolean; localOnly: boolean },
  webSearchOn: boolean,
  prompt: string,
): boolean {
  if (settings.localOnly || !settings.webSearchEnabled) return false;
  return webSearchOn || userWantsWebSearch(prompt);
}

/** Resolved search execution path for a turn. Hosted XOR local — never both. */
export type SearchBackend = 'hosted' | 'local';

/**
 * Whether the active provider/endpoint can run a provider-hosted search tool.
 * Mirrors `endpoint_supports_hosted_search` in the OpenAI adapter plus Gemini.
 */
export function providerHostsSearch(
  activeProvider: string,
  providerEndpoints: { [key in string]?: ProviderEndpointConfig },
): boolean {
  const provider = activeProvider.trim().toLowerCase();
  if (provider === 'gemini') return true;
  if (provider === 'openai' || provider === 'openai_compat') {
    const baseUrl = providerEndpoints[activeProvider]?.baseUrl
      ?? providerEndpoints[provider]?.baseUrl
      ?? (provider === 'openai' ? 'https://api.openai.com/v1' : undefined);
    return endpointSupportsHostedSearch(baseUrl);
  }
  return false;
}

/** Hosts trusted to implement OpenAI's hosted `web_search` (same allowlist as Rust). */
export function endpointSupportsHostedSearch(baseUrl: string | null | undefined): boolean {
  if (!baseUrl?.trim()) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'api.openai.com';
  } catch {
    return false;
  }
}

/**
 * Pick hosted vs local DuckDuckGo for this turn given Settings mode + provider.
 * Call only when `resolveWebSearchForTurn` is true.
 */
export function resolveSearchBackend(
  mode: WebSearchMode | undefined,
  activeProvider: string,
  providerEndpoints: { [key in string]?: ProviderEndpointConfig },
): SearchBackend {
  const resolved = mode ?? 'auto';
  if (resolved === 'local') return 'local';
  if (resolved === 'hosted') return 'hosted';
  // auto
  return providerHostsSearch(activeProvider, providerEndpoints) ? 'hosted' : 'local';
}
