import { describe, expect, it } from 'vitest';
import {
  formatCompactionDeveloperPrompt,
  historyForProviderRequest,
  splitTurnsAtCompaction,
} from './contextCompact';
import type { ChatTurn } from './conversationHydration';
import type { ConversationCompaction } from '../ipc/client';

function turn(id: string, role: 'user' | 'assistant', content: string): ChatTurn {
  return { id, role, content, createdAt: new Date().toISOString() };
}

const compaction: ConversationCompaction = {
  id: 'c1',
  conversationId: 'conv',
  createdAt: '2026-01-01T00:00:00Z',
  summaryText: 'We discussed cats.',
  throughMessageId: 'u3',
  keptFromMessageId: 'u3',
  modelId: 'claude-sonnet-4',
  tokenEstimateBefore: 1000,
  tokenEstimateAfter: 200,
};

describe('contextCompact', () => {
  it('splits turns at keptFromMessageId', () => {
    const turns = [
      turn('u1', 'user', 'hi'),
      turn('a1', 'assistant', 'hello'),
      turn('u3', 'user', 'later'),
      turn('a3', 'assistant', 'ok'),
    ];
    const { kept, compacted } = splitTurnsAtCompaction(turns, compaction);
    expect(compacted.map((t) => t.id)).toEqual(['u1', 'a1']);
    expect(kept.map((t) => t.id)).toEqual(['u3', 'a3']);
    expect(historyForProviderRequest(turns, compaction).map((t) => t.id)).toEqual([
      'u3',
      'a3',
    ]);
  });

  it('leaves history intact without compaction', () => {
    const turns = [turn('u1', 'user', 'hi')];
    expect(splitTurnsAtCompaction(turns, null).kept).toEqual(turns);
    expect(historyForProviderRequest(turns, undefined)).toEqual(turns);
  });

  it('formats a labeled developer prompt', () => {
    expect(formatCompactionDeveloperPrompt('  summary  ')).toContain('Earlier conversation');
    expect(formatCompactionDeveloperPrompt('  summary  ')).toContain('summary');
  });
});
