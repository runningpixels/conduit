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
  keychainMode: 'os',
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
  generationControls: null,
  userInstructions: null,
  contextCompactEnabled: true,
  contextCompactThresholdPercent: 90,
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

  it('puts attachmentReference parts and attachments ids on the request', () => {
    const history: ChatTurn[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'what is this?',
        attachments: [{ id: 'att-png', mimeType: 'image/png', fileName: 'x.png' }],
      },
    ];
    const req = buildProviderRequest(baseSettings, 'what is this?', history, 'c1', []);
    const user = req.messages.find((m) => m.role === 'user')!;
    expect(user.parts).toHaveLength(2);
    expect(user.parts[0].kind).toBe('text');
    expect(user.parts[1]).toMatchObject({
      kind: 'attachmentReference',
      attachmentId: 'att-png',
      mimeType: 'image/png',
    });
    expect(req.attachments).toEqual(['att-png']);
  });

  it('allows image-only user turns', () => {
    const history: ChatTurn[] = [
      {
        id: 'u1',
        role: 'user',
        content: '',
        attachments: [{ id: 'att-1', mimeType: 'image/jpeg' }],
      },
    ];
    const req = buildProviderRequest(baseSettings, '', history, 'c1', []);
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0].parts[0].kind).toBe('attachmentReference');
    expect(req.attachments).toEqual(['att-1']);
  });

  it('puts settings temperature on generationControls', () => {
    const req = buildProviderRequest(
      { ...baseSettings, generationControls: { temperature: 0.2 } },
      'hi',
      [userTurn('u1', 'hi')],
      'c1',
      [],
    );
    expect(req.generationControls?.temperature).toBe(0.2);
  });

  it('appends conversation user instructions after the auto-composed prompt', () => {
    const req = buildProviderRequest(
      { ...baseSettings, userInstructions: 'Default voice.' },
      'hi',
      [userTurn('u1', 'hi')],
      'c1',
      [],
      undefined,
      undefined,
      { userInstructions: 'Always end with BANANA.' },
    );
    expect(req.systemPrompt).toContain('You are a helpful assistant');
    expect(req.systemPrompt).toContain('## User instructions');
    expect(req.systemPrompt).toContain('Always end with BANANA.');
    expect(req.systemPrompt).not.toContain('Default voice.');
    expect(req.systemPrompt!.indexOf('You are a helpful assistant')).toBeLessThan(
      req.systemPrompt!.indexOf('## User instructions'),
    );
  });

  it('inherits settings instructions when the conversation override is cleared', () => {
    const req = buildProviderRequest(
      { ...baseSettings, userInstructions: 'Default voice.' },
      'hi',
      [userTurn('u1', 'hi')],
      'c1',
      [],
    );
    expect(req.systemPrompt).toContain('Default voice.');
  });

  it('injects compaction summary as developer prompt and keeps only provided history', () => {
    const kept = [userTurn('u3', 'later'), assistantTurn('a3', 'ok')];
    const req = buildProviderRequest(
      baseSettings,
      'next',
      [...kept, userTurn('u4', 'next')],
      'c1',
      [],
      undefined,
      undefined,
      { compactionSummary: 'We discussed cats earlier.' },
    );
    expect(req.developerPrompt).toContain('Earlier conversation summary');
    expect(req.developerPrompt).toContain('We discussed cats earlier.');
    expect(req.messages.map((m) => m.id)).toEqual(['u3', 'a3', 'u4']);
    expect(req.messages.some((m) => m.id === 'u1')).toBe(false);
  });
});
