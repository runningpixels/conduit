import { describe, expect, it } from 'vitest';
import { CONDUIT_BRAND_SYSTEM_APPENDIX, looksLikeBrandThemeRequest } from './brandPrompt';
import { CONDUIT_ARTIFACT_SYSTEM_APPENDIX } from './artifactPrompt';
import { baseSystemPrompt, buildProviderRequest } from './ChatView';
import { selectBuiltinBrandTools } from './agentTools';

describe('looksLikeBrandThemeRequest', () => {
  it('detects unambiguous branding vocabulary with no action verb needed', () => {
    expect(looksLikeBrandThemeRequest('rebrand this as Northwind')).toBe(true);
    expect(looksLikeBrandThemeRequest('can we white-label the app?')).toBe(true);
    expect(looksLikeBrandThemeRequest('generate a brand.md for us')).toBe(true);
  });

  it('detects an action verb paired with a branding noun', () => {
    expect(looksLikeBrandThemeRequest('design a warm editorial theme with a burnt-orange accent')).toBe(true);
    expect(looksLikeBrandThemeRequest('make a new colour scheme for the app')).toBe(true);
    expect(looksLikeBrandThemeRequest('change the accent color to teal')).toBe(true);
    expect(looksLikeBrandThemeRequest('give it a new look and feel')).toBe(true);
  });

  it('returns false for normal chat and unrelated colour talk', () => {
    expect(looksLikeBrandThemeRequest('hello')).toBe(false);
    expect(looksLikeBrandThemeRequest('what is rust')).toBe(false);
    expect(looksLikeBrandThemeRequest('what color is the sky')).toBe(false);
  });

  it('returns false for informational questions that mention theme/brand', () => {
    expect(looksLikeBrandThemeRequest('what is a theme?')).toBe(false);
    expect(looksLikeBrandThemeRequest('tell me about white-labeling')).toBe(false);
    expect(looksLikeBrandThemeRequest('explain how brand themes work')).toBe(false);
  });
});

describe('selectBuiltinBrandTools', () => {
  it('returns write_brand_theme only when brand intent is true', () => {
    expect(selectBuiltinBrandTools(false)).toEqual([]);
    const tools = selectBuiltinBrandTools(true);
    expect(tools.map((t) => t.name)).toEqual(['write_brand_theme']);
    expect(tools[0].displayGroup).toBe('Branding');
    expect(tools[0].permissionLevel).toBe('sideEffectful');
  });
});

describe('buildProviderRequest brand appendix (cost gating)', () => {
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
  contextCompactEnabled: true,
  contextCompactThresholdPercent: 90,
  };

  it('omits the brand appendix on an ordinary turn', () => {
    const req = buildProviderRequest(baseSettings, 'hi', [], 'c1', []);
    expect(req.systemPrompt).not.toContain(CONDUIT_BRAND_SYSTEM_APPENDIX());
    expect(req.systemPrompt).toContain(baseSystemPrompt());
  });

  it('includes the brand appendix when the prompt asks for a theme', () => {
    const req = buildProviderRequest(
      baseSettings,
      'design a warm editorial theme with a burnt-orange accent',
      [],
      'c1',
      [],
    );
    expect(req.systemPrompt).toContain(CONDUIT_BRAND_SYSTEM_APPENDIX());
    expect(req.systemPrompt).toContain('write_brand_theme');
  });

  it('includes the brand appendix alongside the artifact appendix, not instead of it', () => {
    const req = buildProviderRequest(baseSettings, 'rebrand this as Northwind', [], 'c1', []);
    expect(req.systemPrompt).toContain(CONDUIT_BRAND_SYSTEM_APPENDIX());
    expect(req.systemPrompt).toContain(CONDUIT_ARTIFACT_SYSTEM_APPENDIX());
  });
});
