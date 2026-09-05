import { describe, expect, it } from 'vitest';
import {
  localWebSearchDeveloperPromptFor,
  webSearchCreateDeveloperPromptFor,
  webSearchDeveloperPromptFor,
} from './webSearchDeveloperPrompt';
import { buildProviderRequest } from './ChatView';
import { selectBuiltinWebTools } from './agentTools';

describe('webSearchDeveloperPromptFor', () => {
  it('instructs concise answers and provider citations only', () => {
    const prompt = webSearchDeveloperPromptFor();
    expect(prompt).toContain('1–2 sentences');
    expect(prompt).toContain('Do not add a separate Sources section');
    expect(prompt).toContain('web_search tool');
  });
});

describe('localWebSearchDeveloperPromptFor', () => {
  it('points at the DuckDuckGo builtin and JSON results', () => {
    const prompt = localWebSearchDeveloperPromptFor();
    expect(prompt).toContain('DuckDuckGo');
    expect(prompt).toContain('web_search');
    expect(prompt).toContain('web_fetch');
    expect(prompt).toContain('JSON');
  });

  it('limits Instant Answer use and forbids binge retries', () => {
    const prompt = localWebSearchDeveloperPromptFor();
    expect(prompt).toMatch(/at most once or twice/i);
    expect(prompt).toMatch(/Instant Answer/i);
    expect(prompt).toMatch(/not a live news/i);
    expect(prompt).toMatch(/Do not retry similar query variants/i);
  });

  it('names Tavily when that backend is selected', () => {
    const prompt = localWebSearchDeveloperPromptFor('tavily');
    expect(prompt).toContain('Tavily');
    expect(prompt).toContain('live web results');
    expect(prompt).not.toContain('Instant Answer');
  });
});

describe('webSearchCreateDeveloperPromptFor', () => {
  it('instructs one write then edit-or-stop', () => {
    const prompt = webSearchCreateDeveloperPromptFor();
    expect(prompt).toContain('write_*_document once');
    expect(prompt).toContain('edit_*_document');
    expect(prompt).toContain('no further tool calls');
  });
});

describe('selectBuiltinWebTools', () => {
  it('returns web_search and web_fetch only', () => {
    const names = selectBuiltinWebTools().map((t) => t.name).sort();
    expect(names).toEqual(['web_fetch', 'web_search']);
  });
});

describe('buildProviderRequest web search prompts', () => {
  const baseSettings = {
    activeProvider: 'openai',
    activeModel: 'gpt-test',
    localOnly: false,
    diagnosticsEnabled: true,
    theme: 'system' as const,
    providerEndpoints: {},
    artifactRemoteAllowlist: [],
    artifactStyledPreview: true,
    updateChannel: 'stable' as const,
    updateCheckEnabled: true,
    onboardingCompleted: true,
    webSearchEnabled: true,
    webSearch: {
      mode: 'auto' as const,
      localBackend: 'duckduckgo' as const,
      searchContextSize: 'medium' as const,
      allowedDomains: [],
      blockedDomains: [],
      externalWebAccess: true,
      returnTokenBudget: 'default' as const,
      includeSources: false,
    },
    webSearchConsentAcknowledged: true,
    agent: {
      maxSteps: 25,
      wallClockBudgetSecs: 300,
    },
    keychainMode: 'os' as const,
    brandingEnabled: false,
    workspaceToolsEnabled: false,
    workspaceRoot: null,
    workspaceToolsConsentAcknowledged: false,
    generationControls: null,
    userInstructions: null,
  contextCompactEnabled: true,
  contextCompactThresholdPercent: 90,
  memoryEnabled: true,
  };

  it('uses hosted developer prompt and injects webSearch for hosted turns', () => {
    const req = buildProviderRequest(
      baseSettings,
      'search the web for market news',
      [],
      'c1',
      [],
      undefined,
      'hosted',
    );
    expect(req.webSearch?.enabled).toBe(true);
    expect(req.developerPrompt).toContain('Do not add a separate Sources section');
    expect(req.developerPrompt).not.toContain('Answer in text only');
    expect(req.systemPrompt).not.toContain('Artifacts are created from fenced code blocks');
  });

  it('uses local developer prompt and omits ProviderRequest.webSearch for local turns', () => {
    const req = buildProviderRequest(
      baseSettings,
      'search the web for DuckDuckGo',
      [],
      'c1',
      selectBuiltinWebTools(),
      undefined,
      'local',
    );
    expect(req.webSearch).toBeUndefined();
    expect(req.toolDefinitions.map((t) => t.name)).toContain('web_search');
    expect(req.toolDefinitions.map((t) => t.name)).toContain('web_fetch');
    expect(req.developerPrompt).toContain('DuckDuckGo');
    expect(req.developerPrompt).not.toContain('hosted web_search');
  });

  it('keeps artifact appendix for artifact-creation turns even with search on', () => {
    const req = buildProviderRequest(
      baseSettings,
      'create a new artifact html',
      [],
      'c1',
      [],
      undefined,
      'hosted',
    );
    expect(req.systemPrompt).toContain('render inline in chat first');
    expect(req.developerPrompt).toContain('write_*_document once');
    expect(req.developerPrompt).not.toContain('1–2 sentences');
  });
});
