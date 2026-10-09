import { describe, expect, it } from 'vitest';
import type { Artifact } from '../ipc/contracts';
import type { AssistantStreamState, ToolCallState } from './streamState';
import {
  ARTIFACT_SCOPE_CONTENT_CAP,
  buildArtifactEditDeveloperPrompt,
  looksLikeArtifactEditFollowUp,
  looksLikeExplicitNewArtifactRequest,
  resolveFollowUpArtifactContext,
  resolveRecentDocumentArtifactId,
  resolveTurnDocumentScope,
  shouldIncludeArtifactFollowUpContext,
} from './artifactFollowUpContext';
import { baseSystemPrompt, buildProviderRequest } from './ChatView';
import { CONDUIT_ARTIFACT_SYSTEM_APPENDIX } from './artifactPrompt';
import { builtinToolDefinitions, selectBuiltinTurnTools } from './agentTools';

function makeToolCall(name: string, args: Record<string, unknown>): ToolCallState {
  return {
    toolCallId: 'tc-1',
    toolId: name,
    name,
    argumentsText: JSON.stringify(args),
    arguments: args,
    complete: true,
    status: 'completed',
  };
}

function makeStreamState(toolCalls: ToolCallState[]): AssistantStreamState {
  return {
    requestId: 'req-1',
    blocks: [],
    reasoning: [],
    toolCalls,
    segments: [],
    searchSources: [],
    interrupted: false,
    streaming: false,
  };
}

const baseSettings = {
  activeProvider: 'openai',
  activeModel: 'gpt-test',
  localOnly: true,
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

const listedArtifacts: Artifact[] = [
  {
    id: 'art-html-1',
    conversationId: 'c1',
    kind: 'html',
    title: 'PHP Outline',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  },
];

describe('looksLikeExplicitNewArtifactRequest', () => {
  it('detects explicit new artifact creation', () => {
    expect(looksLikeExplicitNewArtifactRequest('create a new html artifact')).toBe(true);
    expect(looksLikeExplicitNewArtifactRequest('make a new artifact markdown')).toBe(true);
  });

  it('does not flag edit follow-ups', () => {
    expect(looksLikeExplicitNewArtifactRequest('make it dark mode')).toBe(false);
    expect(looksLikeExplicitNewArtifactRequest('update the colors')).toBe(false);
  });
});

describe('looksLikeArtifactEditFollowUp', () => {
  it('detects common edit phrasing', () => {
    expect(looksLikeArtifactEditFollowUp('make it dark mode')).toBe(true);
    expect(looksLikeArtifactEditFollowUp('can you update the header?')).toBe(true);
    expect(looksLikeArtifactEditFollowUp('add a section on loops')).toBe(true);
    expect(looksLikeArtifactEditFollowUp('can you add urls to the document?')).toBe(true);
  });

  it('returns false for explicit new artifact requests', () => {
    expect(looksLikeArtifactEditFollowUp('create a new html artifact')).toBe(false);
  });
});

describe('resolveRecentDocumentArtifactId', () => {
  it('resolves from the most recent assistant stream state', () => {
    const history = [
      { role: 'user' as const, content: 'create html outline' },
      {
        role: 'assistant' as const,
        content: '',
        streamState: makeStreamState([
          makeToolCall('write_html_document', {
            title: 'PHP Outline',
            html: '<html></html>',
          }),
        ]),
      },
    ];
    expect(resolveRecentDocumentArtifactId(history, listedArtifacts)).toBe('art-html-1');
  });

  it('falls back to the newest listed document artifact', () => {
    expect(resolveRecentDocumentArtifactId([], listedArtifacts)).toBe('art-html-1');
  });

  it('prefers the open panel artifact when provided', () => {
    const other: Artifact = {
      id: 'art-open',
      conversationId: 'c1',
      kind: 'html',
      title: 'Today\'s News',
      createdAt: '2026-01-03T00:00:00Z',
      updatedAt: '2026-01-03T00:00:00Z',
    };
    expect(
      resolveRecentDocumentArtifactId([], [other, ...listedArtifacts], 'art-open'),
    ).toBe('art-open');
  });
});

describe('shouldIncludeArtifactFollowUpContext', () => {
  const historyWithDocTools = [
    {
      role: 'assistant' as const,
      content: '',
      streamState: makeStreamState([makeToolCall('write_html_document', { html: '<html></html>' })]),
    },
  ];

  it('includes context for edit follow-ups when an artifact exists', () => {
    expect(shouldIncludeArtifactFollowUpContext('make it dark mode', [], 'art-html-1')).toBe(true);
  });

  it('skips context when the last assistant turn used document tools but the user did not ask to edit', () => {
    expect(
      shouldIncludeArtifactFollowUpContext('looks good', historyWithDocTools, 'art-html-1'),
    ).toBe(false);
  });

  it('skips context for informational questions after document tools', () => {
    expect(
      shouldIncludeArtifactFollowUpContext(
        'what types of documents can you create?',
        historyWithDocTools,
        'art-html-1',
      ),
    ).toBe(false);
  });

  it('skips when the user asks for a new artifact', () => {
    expect(
      shouldIncludeArtifactFollowUpContext('create a new html artifact', historyWithDocTools, 'art-html-1'),
    ).toBe(false);
  });

  it('includes context for edit follow-ups when inline document exists', () => {
    const history = [
      {
        role: 'assistant' as const,
        content: '```markdown\n# Notes\n\nBody\n```',
      },
    ];
    expect(shouldIncludeArtifactFollowUpContext('make it shorter', history, undefined)).toBe(true);
  });

  it('skips when no artifact is in scope', () => {
    expect(shouldIncludeArtifactFollowUpContext('make it dark mode', [], undefined)).toBe(false);
  });
});

describe('buildArtifactEditDeveloperPrompt', () => {
  it('names the edit tool and artifact id', () => {
    const prompt = buildArtifactEditDeveloperPrompt(
      {
        artifactId: 'art-html-1',
        kind: 'html',
        title: 'PHP Outline',
        content: '<html><body>light</body></html>',
      },
      'make it dark mode',
    );
    expect(prompt).toContain('artifact_id: art-html-1');
    expect(prompt).toContain('edit_html_document');
    expect(prompt).toContain('updated_html');
    expect(prompt).toContain('make it dark mode');
    expect(prompt).toContain('<html><body>light</body></html>');
    expect(prompt).toContain('Only call a document tool if the user explicitly asked');
    expect(prompt).toContain('Do NOT call write_*_document without artifact_id');
  });
});

describe('resolveFollowUpArtifactContext', () => {
  it('returns artifact context for a dark-mode follow-up', async () => {
    const history = [
      {
        role: 'assistant' as const,
        content: '',
        streamState: makeStreamState([
          makeToolCall('write_html_document', { html: '<html><body>light</body></html>' }),
        ]),
      },
    ];
    const ctx = await resolveFollowUpArtifactContext(
      history,
      'make it dark mode',
      listedArtifacts,
      async () => ({
        ...listedArtifacts[0],
        contentText: '<html><body>light</body></html>',
      }),
    );
    expect(ctx).toEqual({
      artifactId: 'art-html-1',
      kind: 'html',
      title: 'PHP Outline',
      content: '<html><body>light</body></html>',
    });
  });

  it('prefers the open panel artifact over a older listed document', async () => {
    const openDoc: Artifact = {
      id: 'art-news',
      conversationId: 'c1',
      kind: 'html',
      title: 'Today\'s News',
      contentText: '<html><body>news</body></html>',
      createdAt: '2026-01-03T00:00:00Z',
      updatedAt: '2026-01-03T00:00:00Z',
    };
    const ctx = await resolveFollowUpArtifactContext(
      [],
      'can you add urls to the document?',
      listedArtifacts,
      async (id) => (id === 'art-news' ? openDoc : { ...listedArtifacts[0], contentText: '<html></html>' }),
      openDoc,
    );
    expect(ctx?.artifactId).toBe('art-news');
    expect(ctx?.title).toBe('Today\'s News');
    expect(ctx?.content).toContain('news');
  });

  it('returns undefined for informational questions after document tools', async () => {
    const history = [
      {
        role: 'assistant' as const,
        content: '',
        streamState: makeStreamState([
          makeToolCall('write_html_document', { html: '<html></html>' }),
        ]),
      },
    ];
    const ctx = await resolveFollowUpArtifactContext(
      history,
      'what types of documents can you create?',
      listedArtifacts,
      async () => ({
        ...listedArtifacts[0],
        contentText: '<html></html>',
      }),
    );
    expect(ctx).toBeUndefined();
  });

  it('returns undefined for explicit new artifact requests', async () => {
    const history = [
      {
        role: 'assistant' as const,
        content: '',
        streamState: makeStreamState([
          makeToolCall('write_html_document', { html: '<html></html>' }),
        ]),
      },
    ];
    const ctx = await resolveFollowUpArtifactContext(
      history,
      'create a new html artifact',
      listedArtifacts,
      async () => null,
    );
    expect(ctx).toBeUndefined();
  });

  it('falls back to tool-call arguments when getArtifact has no content', async () => {
    const history = [
      {
        role: 'assistant' as const,
        content: '',
        streamState: makeStreamState([
          makeToolCall('write_markdown_document', { markdown: '# Notes\n\nBody' }),
        ]),
      },
    ];
    const markdownArtifacts: Artifact[] = [
      {
        id: 'art-md-1',
        conversationId: 'c1',
        kind: 'markdown',
        title: 'Notes',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    const ctx = await resolveFollowUpArtifactContext(
      history,
      'add a conclusion',
      markdownArtifacts,
      async () => ({ ...markdownArtifacts[0] }),
    );
    expect(ctx?.kind).toBe('markdown');
    expect(ctx?.content).toBe('# Notes\n\nBody');
  });

  it('returns undefined when there is no prior artifact or inline document', async () => {
    const ctx = await resolveFollowUpArtifactContext([], 'make it dark mode', [], async () => null);
    expect(ctx).toBeUndefined();
  });

  it('returns inline context from unpromoted fenced assistant content', async () => {
    const history = [
      {
        role: 'assistant' as const,
        content: '```html\n<html><body>light</body></html>\n```',
      },
    ];
    const ctx = await resolveFollowUpArtifactContext(
      history,
      'make it dark mode',
      [],
      async () => null,
    );
    expect(ctx).toEqual({
      kind: 'html',
      title: '<html><body>light</body></html>',
      content: '<html><body>light</body></html>',
      inlineOnly: true,
    });
  });

  it('builds inline edit prompt without artifact_id when content is unpromoted', () => {
    const prompt = buildArtifactEditDeveloperPrompt(
      {
        kind: 'html',
        content: '<html><body>light</body></html>',
        inlineOnly: true,
      },
      'make it dark mode',
    );
    expect(prompt).toContain('inline in chat');
    expect(prompt).not.toContain('artifact_id:');
    expect(prompt).toContain('fenced code block');
  });
});

describe('buildProviderRequest follow-up artifact context', () => {
  it('includes edit developer prompt for follow-up edits', () => {
    const req = buildProviderRequest(
      baseSettings,
      'make it dark mode',
      [{ id: 'u1', role: 'user', content: 'make it dark mode' }],
      'c1',
      [],
      {
        artifactId: 'art-html-1',
        kind: 'html',
        title: 'PHP Outline',
        content: '<html><body>light</body></html>',
      },
    );
    expect(req.developerPrompt).toContain('edit_html_document');
    expect(req.developerPrompt).toContain('art-html-1');
  });

  it('does not inject an edit developer prompt on a creation-intent turn', () => {
    // Creation intent suppresses the edit follow-up prompt (so an explicit
    // "create a new" while an artifact is in scope does not get rerouted into
    // editing it). We no longer inject a positive creation developer prompt; we
    // just assert the edit prompt is absent and the contract lives in the
    // system appendix instead.
    const req = buildProviderRequest(
      baseSettings,
      'create a new artifact html',
      [{ id: 'u2', role: 'user', content: 'create a new artifact html' }],
      'c1',
      [],
      {
        artifactId: 'art-html-1',
        kind: 'html',
        content: '<html></html>',
      },
    );
    expect(req.developerPrompt ?? '').not.toContain('edit_html_document');
    expect(req.systemPrompt).toContain(CONDUIT_ARTIFACT_SYSTEM_APPENDIX());
  });

  it('includes informational developer prompt for capability questions', () => {
    const req = buildProviderRequest(
      baseSettings,
      'what types of documents can you create?',
      [{ id: 'u3', role: 'user', content: 'what types of documents can you create?' }],
      'c1',
      [],
    );
    expect(req.developerPrompt).toContain('text only');
    expect(req.developerPrompt).not.toContain('edit_html_document');
  });

  it('includes edit-tool guidance in system prompt when the tools are offered', () => {
    const tools = builtinToolDefinitions().filter((t) => t.name === 'write_html_document' || t.name === 'patch_document');
    const req = buildProviderRequest(baseSettings, 'hello', [], 'c1', tools);
    expect(req.systemPrompt).toContain('Only call write_*_document or edit_*_document');
    expect(req.systemPrompt).toContain(baseSystemPrompt());
  });

  // Naming tools the turn does not offer had GLM calling them anyway — refused
  // as undeclared, or written into the answer as call markup.
  it('names no document tools when none are offered', () => {
    const req = buildProviderRequest(baseSettings, 'hello', [], 'c1', []);
    expect(req.systemPrompt).not.toMatch(/write_\*_document|edit_\*_document|patch_document/);
    expect(req.systemPrompt).toContain('No document tools are available for this message');
  });
});

describe('a document in scope reaches every follow-up (resolveTurnDocumentScope)', () => {
  const dashboard: Artifact = {
    id: '799435b7-aaaa-4bbb-8ccc-dddddddddddd',
    conversationId: 'c1',
    kind: 'html',
    title: 'Ridgewood Weather Dashboard',
    contentText: '<main><h1>Ridgewood</h1></main>',
    sourceMessageId: 'a2',
    createdAt: '2026-10-09T10:00:00Z',
  };
  const history = [
    { role: 'user' as const, content: 'Make a weather dashboard for Paris' },
    {
      role: 'assistant' as const,
      content: 'Here it is.',
      streamState: makeStreamState([makeToolCall('write_html_document', { title: 'Paris', html: '<p>' })]),
    },
  ];
  const get = async () => dashboard;

  async function turnFor(prompt: string, options: { open?: Artifact | null; listed?: Artifact[]; search?: 'hosted' | null } = {}) {
    const listed = options.listed ?? [dashboard];
    const open = options.open === undefined ? dashboard : options.open;
    const turnHistory = listed.length > 0 ? history : [];
    const scope = resolveTurnDocumentScope(prompt, turnHistory, listed, open);
    const { tools } = selectBuiltinTurnTools(prompt, { ...baseSettings }, null, scope.toolIntent);
    const followUp = await resolveFollowUpArtifactContext(turnHistory, prompt, listed, get, open, {
      forceEdit: scope.forceEdit,
      fromScope: scope.fromScope,
    });
    const request = buildProviderRequest(
      baseSettings,
      prompt,
      [{ id: 'u9', role: 'user', content: prompt }],
      'c1',
      tools,
      followUp,
      options.search ?? null,
    );
    return { scope, names: tools.map((t) => t.name), followUp, request };
  }

  it('the question-shaped request from the failed chat gets edit tools and the document id', async () => {
    const { scope, names, request } = await turnFor('nice, can you make a nice chart in it?', { search: 'hosted' });
    expect(scope.toolIntent).toBe('edit');
    expect(names).toEqual(expect.arrayContaining(['edit_html_document', 'patch_document', 'read_document']));
    expect(names).not.toContain('write_html_document');
    expect(request.developerPrompt).toContain(`artifact_id: ${dashboard.id}`);
    expect(request.developerPrompt).toContain('Ridgewood Weather Dashboard');
    expect(request.developerPrompt).toContain('do not search files for it');
    expect(request.developerPrompt).not.toContain('Answer in text only');
    // The artifact appendix stays on a search turn when a document is in scope.
    expect(request.systemPrompt).toContain('patch_document');
  });

  it('works the same in another language', async () => {
    const { names, request } = await turnFor('tu peux ajouter un joli graphique dedans ?');
    expect(names).toEqual(expect.arrayContaining(['edit_html_document', 'patch_document', 'read_document']));
    expect(request.developerPrompt).toContain(`artifact_id: ${dashboard.id}`);
    expect(request.developerPrompt).toContain('in any language');
  });

  it('the latest document in the chat counts when the panel is closed', async () => {
    const { names, request } = await turnFor('und jetzt bitte mit Regenradar', { open: null });
    expect(names).toContain('patch_document');
    expect(request.developerPrompt).toContain(dashboard.id);
  });

  it('names a long document instead of pasting it when the turn did not read as an edit', async () => {
    const long = { ...dashboard, contentText: `<main>${'x'.repeat(ARTIFACT_SCOPE_CONTENT_CAP + 10)}</main>` };
    const scope = resolveTurnDocumentScope('nice!', history, [long], long);
    const followUp = await resolveFollowUpArtifactContext(history, 'nice!', [long], async () => long, long, scope);
    const prompt = buildArtifactEditDeveloperPrompt(followUp!, 'nice!');
    expect(prompt).toContain(`call read_document with artifact_id "${dashboard.id}"`);
    expect(prompt).not.toContain('xxxxxxxxxx');
    // An edit-worded turn still gets the content to patch against.
    const edit = await resolveFollowUpArtifactContext(history, 'make it dark mode', [long], async () => long, long, {
      forceEdit: true,
    });
    expect(buildArtifactEditDeveloperPrompt(edit!, 'make it dark mode')).toContain('xxxxxxxxxx');
  });

  it('an explicit request for a new document still gets the create tools', async () => {
    const { scope, names, followUp } = await turnFor('make a new weather dashboard for Tokyo');
    expect(scope.toolIntent).toBeUndefined();
    expect(names).toContain('write_html_document');
    expect(followUp).toBeUndefined();
  });

  it('a fresh chat with no document behaves as before', async () => {
    const { scope, names, followUp, request } = await turnFor('what is the capital of France?', {
      open: null,
      listed: [],
    });
    expect(scope).toEqual({ toolIntent: undefined, forceEdit: false, fromScope: false });
    expect(names.some((n) => /document/.test(n))).toBe(false);
    expect(followUp).toBeUndefined();
    expect(request.developerPrompt).toContain('Answer in text only');
    // An edit-sounding prompt with nothing to edit gets no edit-only tool set.
    expect(resolveTurnDocumentScope('add a summary', [], [], null).toolIntent).toBe('general');
  });

  it('an app-authored intent wins', () => {
    expect(resolveTurnDocumentScope('Continue building', history, [dashboard], dashboard, 'edit')).toEqual({
      toolIntent: 'edit',
      forceEdit: true,
      fromScope: false,
    });
  });
});

describe('resolveFollowUpArtifactContext with forceEdit', () => {
  const openDoc: Artifact = {
    id: 'art-guide',
    conversationId: 'c1',
    kind: 'html',
    title: 'Planets',
    contentText: '<main><!-- section: moons --></main>',
    createdAt: '2026-01-03T00:00:00Z',
    updatedAt: '2026-01-03T00:00:00Z',
  };

  it('includes the open document for a prompt the classifier cannot read', async () => {
    const prompt = 'Baue das Dokument weiter auf.';
    const get = async () => openDoc;
    expect(await resolveFollowUpArtifactContext([], prompt, [openDoc], get, openDoc)).toBeUndefined();
    const ctx = await resolveFollowUpArtifactContext([], prompt, [openDoc], get, openDoc, { forceEdit: true });
    expect(ctx?.artifactId).toBe('art-guide');
    expect(ctx?.content).toContain('section: moons');
  });
});
