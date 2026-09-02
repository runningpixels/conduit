import { describe, expect, it } from 'vitest';
import {
  endpointSupportsHostedSearch,
  providerHostsSearch,
  resolveSearchBackend,
  resolveWebSearchForTurn,
  userWantsWebSearch,
} from './webSearchIntent';

describe('userWantsWebSearch', () => {
  it('matches explicit internet search phrasing', () => {
    expect(userWantsWebSearch('search the internet for this weeks latest market news')).toBe(true);
    expect(userWantsWebSearch('look up online what happened today')).toBe(true);
  });

  it('does not match generic chat', () => {
    expect(userWantsWebSearch('hello')).toBe(false);
    expect(userWantsWebSearch('summarize this paragraph')).toBe(false);
  });
});

describe('resolveWebSearchForTurn', () => {
  const enabled = { webSearchEnabled: true, localOnly: false };

  it('honors the per-turn toggle', () => {
    expect(resolveWebSearchForTurn(enabled, true, 'hello')).toBe(true);
  });

  it('auto-enables for search-intent prompts when globally enabled', () => {
    expect(
      resolveWebSearchForTurn(enabled, false, 'search the internet for market news'),
    ).toBe(true);
  });

  it('stays off when local-only or globally disabled', () => {
    expect(
      resolveWebSearchForTurn(
        { webSearchEnabled: true, localOnly: true },
        false,
        'search the internet',
      ),
    ).toBe(false);
    expect(
      resolveWebSearchForTurn(
        { webSearchEnabled: false, localOnly: false },
        false,
        'search the internet',
      ),
    ).toBe(false);
  });
});

describe('endpointSupportsHostedSearch', () => {
  it('accepts api.openai.com', () => {
    expect(endpointSupportsHostedSearch('https://api.openai.com/v1')).toBe(true);
    expect(endpointSupportsHostedSearch('https://api.openai.com')).toBe(true);
  });

  it('rejects other hosts and garbage', () => {
    expect(endpointSupportsHostedSearch('http://localhost:8080/v1')).toBe(false);
    expect(endpointSupportsHostedSearch('https://openrouter.ai/api/v1')).toBe(false);
    expect(endpointSupportsHostedSearch(undefined)).toBe(false);
    expect(endpointSupportsHostedSearch('not a url')).toBe(false);
  });
});

describe('providerHostsSearch', () => {
  it('treats gemini as hosted', () => {
    expect(providerHostsSearch('gemini', {})).toBe(true);
  });

  it('treats openai default endpoint as hosted', () => {
    expect(providerHostsSearch('openai', {})).toBe(true);
  });

  it('treats ollama as not hosted', () => {
    expect(providerHostsSearch('ollama', {})).toBe(false);
  });

  it('treats openai_compat localhost as not hosted', () => {
    expect(
      providerHostsSearch('openai_compat', {
        openai_compat: { baseUrl: 'http://localhost:8080/v1' },
      }),
    ).toBe(false);
  });

  it('treats official anthropic as hosted', () => {
    expect(providerHostsSearch('anthropic', {})).toBe(true);
  });

  it('treats a custom anthropic-compatible host as not hosted', () => {
    expect(
      providerHostsSearch('anthropic', {
        anthropic: { baseUrl: 'https://example.invalid/anthropic' },
      }),
    ).toBe(false);
  });
});

describe('resolveSearchBackend', () => {
  it('Auto + OpenAI → hosted', () => {
    expect(resolveSearchBackend('auto', 'openai', {})).toBe('hosted');
  });

  it('Auto + Ollama → local', () => {
    expect(resolveSearchBackend('auto', 'ollama', {})).toBe('local');
  });

  it('Local + OpenAI → local', () => {
    expect(resolveSearchBackend('local', 'openai', {})).toBe('local');
  });

  it('Hosted + Ollama → hosted (adapter still strips)', () => {
    expect(resolveSearchBackend('hosted', 'ollama', {})).toBe('hosted');
  });

  it('Auto + Anthropic → hosted', () => {
    expect(resolveSearchBackend('auto', 'anthropic', {})).toBe('hosted');
  });

  it('Local + Anthropic → local', () => {
    expect(resolveSearchBackend('local', 'anthropic', {})).toBe('local');
  });

  it('undefined mode defaults to Auto', () => {
    expect(resolveSearchBackend(undefined, 'ollama', {})).toBe('local');
    expect(resolveSearchBackend(undefined, 'gemini', {})).toBe('hosted');
    expect(resolveSearchBackend(undefined, 'anthropic', {})).toBe('hosted');
  });
});
