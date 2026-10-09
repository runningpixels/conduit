import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  localWebSearchDeveloperPromptFor,
  WEB_FETCH_MAX_PER_TURN,
  webFetchDeveloperPromptFor,
  webSearchCreateDeveloperPromptFor,
  webSearchDeveloperPromptFor,
} from './webSearchDeveloperPrompt';
import { buildProviderRequest } from './ChatView';
import {
  builtinToolDefinitions,
  dedupeToolsByName,
  selectBuiltinWebTools,
  selectTurnWebTools,
} from './agentTools';

const here = dirname(fileURLToPath(import.meta.url));

describe('webSearchDeveloperPromptFor', () => {
  it('instructs concise answers and provider citations only', () => {
    const prompt = webSearchDeveloperPromptFor();
    expect(prompt).toContain('1–2 sentences');
    expect(prompt).toContain('Do not add a separate Sources section');
    expect(prompt).toContain('web_search tool');
  });
});

describe('localWebSearchDeveloperPromptFor', () => {
  it('defaults to Exa, with live results and descriptive queries', () => {
    const prompt = localWebSearchDeveloperPromptFor();
    expect(prompt).toContain('Exa');
    expect(prompt).toContain('live web results');
    expect(prompt).toMatch(/description of the page/i);
    expect(prompt).not.toContain('Instant Answer');
  });

  it('points at the DuckDuckGo builtin and JSON results', () => {
    const prompt = localWebSearchDeveloperPromptFor('duckduckgo');
    expect(prompt).toContain('DuckDuckGo');
    expect(prompt).toContain('web_search');
    expect(prompt).toContain('web_fetch');
    expect(prompt).toContain('JSON');
  });

  it('limits Instant Answer use and forbids binge retries', () => {
    const prompt = localWebSearchDeveloperPromptFor('duckduckgo');
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

  it('gives a hosted-search turn web_fetch alone, so it can read what it finds', () => {
    expect(selectBuiltinWebTools('hosted').map((t) => t.name)).toEqual(['web_fetch']);
  });
});

function baseSettingsForFetch() {
  return { ...baseSettings, webSearch: { ...baseSettings.webSearch, mode: 'local' as const } };
}

const baseSettings = {
    activeProvider: 'openai',
    activeModel: 'gpt-test',
    localOnly: false,
    diagnosticsEnabled: true,
    theme: 'system' as const,
    language: 'system' as const,
    providerEndpoints: {},
    modelPriceOverrides: [],
    artifactRemoteAllowlist: [],
    artifactStyledPreview: true,
    artifactNetworkEnabled: true,
    closeToTray: false,
    closeToTrayOffered: false,
    updateChannel: 'stable' as const,
    updateCheckEnabled: true,
    updatePolicy: 'manual' as const,
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
    imageGenerationConsentAcknowledged: false,
    embeddingConsentProviders: [],
    pdfImportNoticeAcknowledged: false,
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
  accent: {},
  };

describe('buildProviderRequest web search prompts', () => {
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

describe('webFetchDeveloperPromptFor', () => {
  it('tells the model to open named sites, follow links within the cap and cite them', () => {
    const prompt = webFetchDeveloperPromptFor();
    expect(prompt).toContain('web_fetch');
    expect(prompt).toContain("instead of saying you can't browse");
    expect(prompt).toContain(`up to ${WEB_FETCH_MAX_PER_TURN} per turn`);
    expect(prompt).toContain('cite the URLs');
    expect(prompt).not.toContain('write the document once');
    expect(webFetchDeveloperPromptFor({ creating: true })).toContain('write the document once');
  });

  it('the per-turn cap matches Rust', () => {
    const src = readFileSync(join(here, '..', '..', 'src-tauri', 'src', 'stream_manager.rs'), 'utf8');
    expect(src).toMatch(new RegExp(`pub const MAX_WEB_FETCH_PER_TURN: u32 = ${WEB_FETCH_MAX_PER_TURN};`));
  });

  it('the web_fetch description matches Rust word for word', () => {
    const src = readFileSync(join(here, '..', '..', 'src-tauri', 'src', 'agent_tools.rs'), 'utf8');
    const rust = /const WEB_FETCH_DESCRIPTION: &str = "([^"]+)";/.exec(src)?.[1];
    const ts = builtinToolDefinitions().find((t) => t.name === 'web_fetch')?.description;
    expect(rust).toBeDefined();
    expect(ts).toBe(rust);
  });
});

describe('selectTurnWebTools', () => {
  const on = { webSearchEnabled: true, localOnly: false };
  const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name).sort();

  it('offers web_fetch alone when the turn does not search but web access is on', () => {
    expect(names(selectTurnWebTools(null, on))).toEqual(['web_fetch']);
    expect(names(selectTurnWebTools(undefined, on))).toEqual(['web_fetch']);
  });

  it('offers nothing when web access is off or the app is local-only', () => {
    expect(selectTurnWebTools(null, { webSearchEnabled: false, localOnly: false })).toEqual([]);
    expect(selectTurnWebTools(null, { webSearchEnabled: true, localOnly: true })).toEqual([]);
  });

  it('keeps the search-turn selections', () => {
    expect(names(selectTurnWebTools('local', on))).toEqual(['web_fetch', 'web_search']);
    expect(names(selectTurnWebTools('hosted', on))).toEqual(['web_fetch']);
  });

  it('dedupeToolsByName keeps the first of each name', () => {
    const tools = [
      { name: 'web_fetch', id: 1 },
      { name: 'web_search', id: 2 },
      { name: 'web_fetch', id: 3 },
    ];
    expect(dedupeToolsByName(tools).map((t) => t.id)).toEqual([1, 2]);
  });
});

describe('buildProviderRequest web_fetch prompt', () => {
  const settings = baseSettingsForFetch();

  it('adds the fetch line when web_fetch is declared without search', () => {
    const req = buildProviderRequest(settings, 'open example.com and tell me what it says', [], 'c1', selectBuiltinWebTools('hosted'), undefined, null);
    expect(req.developerPrompt).toContain('You can read public web pages with web_fetch.');
  });

  it('leaves it out without web_fetch, and on search turns', () => {
    const none = buildProviderRequest(settings, 'open example.com', [], 'c1', [], undefined, null);
    expect(none.developerPrompt ?? '').not.toContain('You can read public web pages');
    const local = buildProviderRequest(settings, 'open example.com', [], 'c1', selectBuiltinWebTools(), undefined, 'local');
    expect(local.developerPrompt ?? '').not.toContain('You can read public web pages');
  });
});
