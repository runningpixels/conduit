import { describe, expect, it } from 'vitest';
import {
  webSearchCreateDeveloperPromptFor,
  webSearchDeveloperPromptFor,
} from './webSearchDeveloperPrompt';
import { buildProviderRequest } from './ChatView';

describe('webSearchDeveloperPromptFor', () => {
  it('instructs concise answers and provider citations only', () => {
    const prompt = webSearchDeveloperPromptFor();
    expect(prompt).toContain('1–2 sentences');
    expect(prompt).toContain('Do not add a separate Sources section');
    expect(prompt).toContain('web_search tool');
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
  };

  it('uses search developer prompt and slims system prompt for search turns', () => {
    const req = buildProviderRequest(
      baseSettings,
      'search the web for market news',
      [],
      'c1',
      [],
      undefined,
      true,
    );
    expect(req.webSearch?.enabled).toBe(true);
    expect(req.developerPrompt).toContain('Do not add a separate Sources section');
    expect(req.developerPrompt).not.toContain('Answer in text only');
    expect(req.systemPrompt).not.toContain('Artifacts are created from fenced code blocks');
  });

  it('keeps artifact appendix for artifact-creation turns even with search on', () => {
    const req = buildProviderRequest(
      baseSettings,
      'create a new artifact html',
      [],
      'c1',
      [],
      undefined,
      true,
    );
    expect(req.systemPrompt).toContain('render inline in chat first');
    expect(req.developerPrompt).toContain('write_*_document once');
    expect(req.developerPrompt).not.toContain('1–2 sentences');
  });
});
