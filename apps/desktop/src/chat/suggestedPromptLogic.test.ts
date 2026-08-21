import { describe, expect, it } from 'vitest';
import type { Artifact } from '../ipc/contracts';
import type { ChatTurn } from './conversationHydration';
import { deriveSuggestedPrompts } from './suggestedPromptLogic';

const htmlArtifact: Artifact = {
  id: 'art-1',
  conversationId: 'c1',
  kind: 'html',
  title: 'API Overview',
  createdAt: '2026-01-01T00:00:00Z',
};

describe('deriveSuggestedPrompts', () => {
  // The empty thread is a greeting and the composer — no suggestion surface at
  // all — so there is nothing to derive until a turn exists (§10).
  it('returns no prompts for an empty thread', () => {
    const prompts = deriveSuggestedPrompts({ turns: [], artifacts: [] });
    expect(prompts).toEqual([]);
  });

  it('suggests artifact edits when a document artifact is in scope', () => {
    const turns: ChatTurn[] = [
      { id: 'u1', role: 'user', content: 'create an html artifact' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Here is your page.',
        streamState: {
          requestId: 'req-1',
          blocks: [],
          reasoning: [],
          toolCalls: [
            {
              toolCallId: 'tc-1',
              toolId: 'write_html_document',
              name: 'write_html_document',
              argumentsText: '{}',
              arguments: { html: '<html></html>' },
              complete: true,
              status: 'completed',
            },
          ],
          searchSources: [],
          interrupted: false,
          streaming: false,
        },
      },
    ];

    const prompts = deriveSuggestedPrompts({ turns, artifacts: [htmlArtifact] });
    expect(prompts[0].id).toBe('artifact-edit-improve');
    expect(prompts[0].text).toContain('API Overview');
  });

  it('suggests creation retries when the user asked for an artifact but none exists', () => {
    const turns: ChatTurn[] = [
      { id: 'u1', role: 'user', content: 'create a new html artifact' },
      { id: 'a1', role: 'assistant', content: 'I can help with that.' },
    ];

    const prompts = deriveSuggestedPrompts({ turns, artifacts: [] });
    expect(prompts[0].id).toBe('create-retry-html');
  });

  it('suggests informational follow-ups for long assistant replies', () => {
    const turns: ChatTurn[] = [
      { id: 'u1', role: 'user', content: 'explain how routing works' },
      {
        id: 'a1',
        role: 'assistant',
        content:
          'Routing in this system works by matching incoming requests to handlers based on path prefixes and middleware chains.',
      },
    ];

    const prompts = deriveSuggestedPrompts({ turns, artifacts: [] });
    expect(prompts.some((p) => p.id === 'info-summarize')).toBe(true);
  });

  it('falls back to generic follow-ups when no stronger signal exists', () => {
    const turns: ChatTurn[] = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'Hi!' },
    ];

    const prompts = deriveSuggestedPrompts({ turns, artifacts: [] });
    expect(prompts[0].id).toBe('followup-summarize');
  });
});
