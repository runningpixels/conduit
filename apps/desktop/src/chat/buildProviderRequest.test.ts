import { describe, expect, it } from 'vitest';
import { buildProviderRequest } from './ChatView';
import type { AppSettings } from '@conduit/config-schema';
import type { ChatTurn } from './ChatView';

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
  keychainMode: 'os',
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
} as AppSettings;

function userTurn(id: string, content: string): ChatTurn {
  return { id, role: 'user', content };
}
function assistantTurn(id: string, content: string): ChatTurn {
  return { id, role: 'assistant', content };
}

describe('buildProviderRequest message id uniqueness (regression: saved user turns)', () => {
  it('uses each turn own id instead of msg-${index}, so two conversations do not collide on msg-0', () => {
    // Two distinct conversations, each with a first user turn. Previously both
    // requests produced `msg-0` for the user message, and the backend's
    // `INSERT OR IGNORE INTO messages(id PRIMARY KEY, ...)` silently dropped
    // the second conversation's user row — losing the prompt on reload.
    const convoA = buildProviderRequest(
      baseSettings,
      'hello from A',
      [userTurn('uuid-A1', 'hello from A')],
      'convo-A',
      [],
    );
    const convoB = buildProviderRequest(
      baseSettings,
      'hello from B',
      [userTurn('uuid-B1', 'hello from B')],
      'convo-B',
      [],
    );

    const aIds = convoA.messages.map((m) => m.id);
    const bIds = convoB.messages.map((m) => m.id);

    // No id should be shared between the two conversations.
    const shared = aIds.filter((id) => bIds.includes(id));
    expect(shared, `shared ids across conversations: ${shared.join(', ')}`).toEqual([]);

    // And specifically neither should use the old scheme.
    expect(aIds).not.toContain('msg-0');
    expect(bIds).not.toContain('msg-0');
    expect(aIds).toContain('uuid-A1');
    expect(bIds).toContain('uuid-B1');
  });

  it('part ids are derived from the message id (unique per conversation)', () => {
    const req = buildProviderRequest(
      baseSettings,
      'hello',
      [userTurn('uuid-X', 'hello')],
      'convo-X',
      [],
    );
    const userMsg = req.messages.find((m) => m.role === 'user')!;
    expect(userMsg.parts[0].id).toBe('uuid-X-part-0');
    expect(userMsg.parts[0].messageId).toBe('uuid-X');
  });

  it('within a conversation, re-sent history keeps stable ids (dedup via INSERT OR IGNORE)', () => {
    // The same turn object re-sent in a later request must keep its id so the
    // backend's `INSERT OR IGNORE` skips it (idempotent), rather than
    // re-inserting a duplicate row.
    const history = [
      userTurn('uuid-1', 'first'),
      assistantTurn('uuid-2', 'reply'),
      userTurn('uuid-3', 'second'),
    ];
    const req = buildProviderRequest(baseSettings, 'third', history, 'convo-1', []);

    const ids = req.messages.map((m) => m.id);
    // History turns keep their own ids; the new user turn keeps its own id too.
    expect(ids).toContain('uuid-1');
    expect(ids).toContain('uuid-3');
    // Assistant turns are filtered out (content present but role assistant is
    // still sent — verify the id scheme is NOT msg-${index} for any of them.
    expect(ids.every((id) => !/^msg-\d+$/.test(id))).toBe(true);
    // No duplicate ids within a single request.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('empty-content turns are filtered out before id assignment', () => {
    const req = buildProviderRequest(
      baseSettings,
      'real',
      [userTurn('uuid-empty', '   '), userTurn('uuid-real', 'real')],
      'convo-1',
      [],
    );
    const ids = req.messages.map((m) => m.id);
    expect(ids).not.toContain('uuid-empty');
    expect(ids).toContain('uuid-real');
  });
});
