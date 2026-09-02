import { describe, expect, it } from 'vitest';
import {
  looksLikeArtifactCreationRequest,
  CONDUIT_ARTIFACT_SYSTEM_APPENDIX,
} from './artifactPrompt';
import { baseSystemPrompt, buildProviderRequest } from './ChatView';

describe('looksLikeArtifactCreationRequest', () => {
  it('detects create/make/new/generate artifact intent', () => {
    expect(looksLikeArtifactCreationRequest('create a new artifact html')).toBe(true);
    expect(looksLikeArtifactCreationRequest('make an artifact json')).toBe(true);
    expect(looksLikeArtifactCreationRequest('generate artifact markdown')).toBe(true);
    expect(looksLikeArtifactCreationRequest('new artifact code')).toBe(true);
  });

  it('detects artifact with type hints', () => {
    expect(looksLikeArtifactCreationRequest('artifact html please')).toBe(true);
    expect(looksLikeArtifactCreationRequest('show me an artifact json')).toBe(true);
  });

  it('returns false for normal chat', () => {
    expect(looksLikeArtifactCreationRequest('hello')).toBe(false);
    expect(looksLikeArtifactCreationRequest('what is rust')).toBe(false);
    expect(looksLikeArtifactCreationRequest('tell me a joke')).toBe(false);
  });

  it('returns false for informational questions that mention artifacts', () => {
    // These previously matched the `artifact.*html` alternation and were
    // misrouted into artifact-creation prompting.
    expect(looksLikeArtifactCreationRequest('what is an html artifact?')).toBe(false);
    expect(looksLikeArtifactCreationRequest('how do artifacts handle json?')).toBe(false);
    expect(looksLikeArtifactCreationRequest('tell me about html artifacts')).toBe(false);
    expect(looksLikeArtifactCreationRequest('explain what a markdown artifact is')).toBe(false);
  });

  it('still treats phrased-as-a-question ability requests as creation', () => {
    expect(looksLikeArtifactCreationRequest('can you create an html artifact?')).toBe(true);
    expect(looksLikeArtifactCreationRequest('could you make a new json artifact?')).toBe(true);
  });
});

describe('buildProviderRequest artifact prompts', () => {
  const baseSettings = {
    activeProvider: 'openai',
    activeModel: 'gpt-test',
    localOnly: true,
    diagnosticsEnabled: true,
    theme: 'system' as const,
    providerEndpoints: {},
    artifactRemoteAllowlist: [],
    artifactStyledPreview: true,
    updateChannel: 'stable' as const,
    updateCheckEnabled: true,
    onboardingCompleted: true,
    webSearchEnabled: false,
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
    webSearchConsentAcknowledged: false,
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
  };

  it('includes the artifact appendix in systemPrompt', () => {
    const req = buildProviderRequest(baseSettings, 'hi', [], 'c1', []);
    expect(req.systemPrompt).toContain(CONDUIT_ARTIFACT_SYSTEM_APPENDIX());
    expect(req.systemPrompt).toContain('Answer capability and explanatory questions in prose');
    expect(req.systemPrompt).toContain(baseSystemPrompt());
  });

  it('does not inject a positive creation developer prompt (system appendix carries the contract)', () => {
    // We deliberately no longer inject an artifact-creation developer prompt,
    // even on explicit creation intent: the system appendix already states the
    // contract and a false-positive intent match would otherwise pressure the
    // model into creating an artifact on a question turn.
    const reqYes = buildProviderRequest(baseSettings, 'create a new artifact html', [], 'c1', []);
    expect(reqYes.developerPrompt).toBeUndefined();

    const reqNo = buildProviderRequest(baseSettings, 'hello', [], 'c1', []);
    expect(reqNo.developerPrompt).toBeUndefined();
  });

  it('injects an informational developer prompt only for non-artifact questions', () => {
    const reqInfo = buildProviderRequest(baseSettings, 'what types of documents can you create?', [], 'c1', []);
    expect(reqInfo.developerPrompt).toBeDefined();
    expect(reqInfo.developerPrompt).toContain('informational');
    expect(reqInfo.developerPrompt).toContain('text only');
  });
});
