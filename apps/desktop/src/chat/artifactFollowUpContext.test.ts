import { describe, expect, it } from 'vitest';
import type { Artifact } from '../ipc/contracts';
import type { AssistantStreamState, ToolCallState } from './streamState';
import {
  buildArtifactEditDeveloperPrompt,
  looksLikeArtifactEditFollowUp,
  looksLikeExplicitNewArtifactRequest,
  resolveFollowUpArtifactContext,
  resolveRecentDocumentArtifactId,
  shouldIncludeArtifactFollowUpContext,
} from './artifactFollowUpContext';
import { BASE_SYSTEM_PROMPT, buildProviderRequest } from './ChatView';
import { CONDUIT_ARTIFACT_SYSTEM_APPENDIX } from './artifactPrompt';

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
  agent: {
    maxSteps: 25,
    wallClockBudgetSecs: 300,
  },
  keychainMode: 'os' as const,
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
    expect(req.systemPrompt).toContain(CONDUIT_ARTIFACT_SYSTEM_APPENDIX);
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

  it('includes edit-tool guidance in system prompt', () => {
    const req = buildProviderRequest(baseSettings, 'hello', [], 'c1', []);
    expect(req.systemPrompt).toContain('Only call write_*_document or edit_*_document');
    expect(req.systemPrompt).toContain(BASE_SYSTEM_PROMPT);
  });
});
