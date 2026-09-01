// White-label authorization (renderer side): a Mode B build with
// `allowUserBranding = false` must never advertise `write_brand_theme`
// (`selectBuiltinBrandTools`) or spend tokens on its system-prompt appendix
// (`buildProviderRequest`), even when the prompt is an unambiguous
// brand-theme request. This is a SEPARATE test file from
// `brandPrompt.test.ts`, not an extra `describe` block there, because
// `../brand/buildFlags`'s `allowUserBranding` is a module-level constant
// resolved at import time -- `vi.mock` must be in place before
// `./agentTools`/`./ChatView` are first evaluated, and vitest hoists
// `vi.mock` per-file. `brandPrompt.test.ts` relies on the real (unlocked)
// value for the rest of the suite, so that mock cannot live there too.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../brand/buildFlags', () => ({ allowUserBranding: false }));

import { selectBuiltinBrandTools } from './agentTools';
import { baseSystemPrompt, buildProviderRequest } from './ChatView';
import { CONDUIT_BRAND_SYSTEM_APPENDIX } from './brandPrompt';

describe('selectBuiltinBrandTools on a locked (allowUserBranding=false) build', () => {
  it('never returns write_brand_theme, even with brand intent true', () => {
    expect(selectBuiltinBrandTools(true)).toEqual([]);
    expect(selectBuiltinBrandTools(false)).toEqual([]);
  });
});

describe('buildProviderRequest brand appendix on a locked build', () => {
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

  it('omits the brand appendix even for an unambiguous rebrand request', () => {
    const req = buildProviderRequest(
      baseSettings,
      'design a warm editorial theme with a burnt-orange accent',
      [],
      'c1',
      [],
    );
    expect(req.systemPrompt).not.toContain(CONDUIT_BRAND_SYSTEM_APPENDIX());
    expect(req.systemPrompt).toContain(baseSystemPrompt());
  });
});
