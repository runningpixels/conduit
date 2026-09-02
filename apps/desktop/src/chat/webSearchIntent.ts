import type {
  LocalSearchBackend,
  ProviderEndpointConfig,
  WebSearchMode,
} from '@conduit/config-schema';

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

export const SEARCH_CREDENTIAL_IDS = {
  tavily: 'search/tavily',
  brave: 'search/brave',
  searxng: 'search/searxng',
} as const;

export function localSearchBackendOf(
  backend: LocalSearchBackend | undefined | null,
): LocalSearchBackend {
  return backend ?? 'duckduckgo';
}

export function localSearchBackendLabel(
  backend: LocalSearchBackend | undefined | null,
): string {
  switch (localSearchBackendOf(backend)) {
    case 'tavily':
      return 'Tavily';
    case 'brave':
      return 'Brave';
    case 'searxng':
      return 'SearXNG';
    default:
      return 'DuckDuckGo';
  }
}

/**
 * Whether the active provider/endpoint can run a provider-hosted search tool.
 * Mirrors OpenAI `endpoint_supports_hosted_search`, Gemini, and Anthropic
 * `api.anthropic.com`.
 */
export function providerHostsSearch(
  activeProvider: string,
  providerEndpoints: { [key in string]?: ProviderEndpointConfig },
): boolean {
  const provider = activeProvider.trim().toLowerCase();
  if (provider === 'gemini') return true;
  if (provider === 'anthropic') {
    const baseUrl = providerEndpoints[activeProvider]?.baseUrl
      ?? providerEndpoints[provider]?.baseUrl
      ?? 'https://api.anthropic.com';
    return anthropicEndpointSupportsHostedSearch(baseUrl);
  }
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

/** Official Anthropic Messages API host. Empty base URL means the default. */
export function anthropicEndpointSupportsHostedSearch(
  baseUrl: string | null | undefined,
): boolean {
  if (!baseUrl?.trim()) return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.anthropic.com';
  } catch {
    return false;
  }
}

/**
 * Pick hosted vs local search for this turn given Settings mode + provider.
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
  return providerHostsSearch(activeProvider, providerEndpoints) ? 'hosted' : 'local';
}
