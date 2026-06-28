import { describe, expect, it } from 'vitest';
import {
  looksLikeArtifactCreationRequest,
  artifactDeveloperPromptFor,
  CONDUIT_ARTIFACT_SYSTEM_APPENDIX,
} from './artifactPrompt';
import { BASE_SYSTEM_PROMPT, buildProviderRequest } from './ChatView';

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
});

describe('artifactDeveloperPromptFor', () => {
  it('returns a developer prompt for artifact requests', () => {
    const p = artifactDeveloperPromptFor('create a new artifact html');
    expect(p).toBeDefined();
    expect(p).toContain('fenced code block');
  });

  it('returns undefined for non-artifact prompts', () => {
    expect(artifactDeveloperPromptFor('hello')).toBeUndefined();
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
      searchContextSize: 'medium' as const,
      allowedDomains: [],
      blockedDomains: [],
      externalWebAccess: true,
      returnTokenBudget: 'default' as const,
      includeSources: false,
    },
    webSearchConsentAcknowledged: false,
  };

  it('includes the artifact appendix in systemPrompt', () => {
    const req = buildProviderRequest(baseSettings, 'hi', [], 'c1', []);
    expect(req.systemPrompt).toContain(CONDUIT_ARTIFACT_SYSTEM_APPENDIX);
    expect(req.systemPrompt).toContain('Answer capability and explanatory questions in prose');
    expect(req.systemPrompt).toContain(BASE_SYSTEM_PROMPT);
  });

  it('includes developerPrompt only for artifact-intent prompts', () => {
    const reqYes = buildProviderRequest(baseSettings, 'create a new artifact html', [], 'c1', []);
    expect(reqYes.developerPrompt).toBeDefined();
    expect(reqYes.developerPrompt).toContain('fenced code block');

    const reqNo = buildProviderRequest(baseSettings, 'hello', [], 'c1', []);
    expect(reqNo.developerPrompt).toBeUndefined();
  });
});
