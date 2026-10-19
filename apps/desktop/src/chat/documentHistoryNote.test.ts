import { describe, expect, it, vi } from 'vitest';
import type { Message, ProviderEvent } from '@conduit/config-schema';
import {
  TOOL_HISTORY_NOTE_MAX_ENTRIES,
  toolActivityHistoryNote,
  toolHistoryDeveloperPrompt,
  type HistoryNoteArtifact,
} from './agentTools';
import { buildProviderRequest, historyContentForTurn } from './ChatView';
import { applyProviderEvent, createAssistantStreamState, type AssistantStreamState } from './streamState';
import { hydrateAssistantTurn, type ChatTurn } from './conversationHydration';
import type { AppSettings } from '@conduit/config-schema';

vi.mock('../ipc/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ipc/client')>()),
  getRequestProviderEvents: vi.fn(),
}));

import { getRequestProviderEvents } from '../ipc/client';

type Call = { name: string; args: Record<string, unknown>; failed?: boolean };

function callEvents(calls: Call[], requestId = 'req-1'): ProviderEvent[] {
  const events: ProviderEvent[] = [];
  calls.forEach((call, i) => {
    const toolCallId = `tc-${i}`;
    events.push({ kind: 'toolCallStart', requestId, toolCallId, index: i * 2, toolId: call.name, name: call.name });
    events.push({ kind: 'toolCallComplete', requestId, toolCallId, index: i * 2 + 1, arguments: call.args });
    if (call.failed) {
      events.push({
        kind: 'toolExecutionFinished',
        requestId,
        toolCallId,
        toolName: call.name,
        isError: true,
        error: 'missing field html',
      });
    }
  });
  return events;
}

function stateOf(calls: Call[]): AssistantStreamState {
  let state = createAssistantStreamState('req-1');
  for (const event of callEvents(calls)) state = applyProviderEvent(state, event);
  return { ...state, streaming: false };
}

const settings = {
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
  examplesSeeded: false,
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
  agent: { maxSteps: 25, wallClockBudgetSecs: 300 },
  keychainMode: 'os',
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
} as AppSettings;

const ARTIFACT_ID = '799435b7-1111-4222-8333-444455556666';
const listed: HistoryNoteArtifact[] = [
  {
    id: ARTIFACT_ID,
    kind: 'html',
    title: 'Paris Weather Dashboard',
    sourceMessageId: 'msg-assistant-1',
    createdAt: '2026-10-09T10:00:00.000Z',
  },
];

describe('toolActivityHistoryNote', () => {
  it('records a write with the created document and its artifact id, then a fetch', () => {
    const note = toolActivityHistoryNote(
      stateOf([
        { name: 'write_html_document', args: { title: 'Paris Weather Dashboard', html: '<p>' } },
        { name: 'web_fetch', args: { url: 'https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35' } },
      ]),
      { turnId: 'msg-assistant-1', artifacts: listed },
    );
    expect(note).toContain(
      `write_html_document: created HTML document "Paris Weather Dashboard" (artifact_id ${ARTIFACT_ID})`,
    );
    expect(note).toContain('web_fetch: https://api.open-meteo.com/v1/forecast');
    expect(note).not.toContain('App record');
    // Never the document body.
    expect(note).not.toContain('<p>');
  });

  it('names edits, patches and reads by artifact id', () => {
    const note = toolActivityHistoryNote(
      stateOf([
        { name: 'read_document', args: { artifact_id: ARTIFACT_ID } },
        { name: 'patch_document', args: { artifact_id: ARTIFACT_ID, edits: [{ old_text: 'a', new_text: 'b' }] } },
        { name: 'edit_html_document', args: { artifact_id: ARTIFACT_ID, updated_html: '<main>' } },
      ]),
      { turnId: 'msg-assistant-2', artifacts: listed },
    );
    expect(note).toContain(`read_document: read HTML document "Paris Weather Dashboard" (artifact_id ${ARTIFACT_ID})`);
    expect(note).toContain(`patch_document: changed 1 part of HTML document "Paris Weather Dashboard" (artifact_id ${ARTIFACT_ID})`);
    expect(note).toContain(`edit_html_document: rewrote HTML document "Paris Weather Dashboard" (artifact_id ${ARTIFACT_ID})`);
    expect(note).not.toContain('<main>');
  });

  it('leaves out failed calls, caps the list and clips long values', () => {
    const many: Call[] = Array.from({ length: TOOL_HISTORY_NOTE_MAX_ENTRIES + 3 }, (_, i) => ({
      name: 'web_fetch',
      args: { url: `https://example.com/${'x'.repeat(200)}/${i}` },
    }));
    const note = toolActivityHistoryNote(stateOf([{ name: 'write_html_document', args: { title: 'Broken' }, failed: true }, ...many]));
    expect(note).not.toContain('Broken');
    expect(note.match(/web_fetch: /g)).toHaveLength(TOOL_HISTORY_NOTE_MAX_ENTRIES);
    expect(note.endsWith('; and 3 more tool calls')).toBe(true);
    expect(note).not.toContain('x'.repeat(150));
  });

  it('is empty without a successful tool call', () => {
    expect(toolActivityHistoryNote(undefined)).toBe('');
    expect(toolActivityHistoryNote(stateOf([]))).toBe('');
    expect(toolActivityHistoryNote(stateOf([{ name: 'web_search', args: { query: 'x' }, failed: true }]))).toBe('');
  });
});

describe('toolHistoryDeveloperPrompt', () => {
  const wrote: ChatTurn = {
    id: 'msg-assistant-1',
    role: 'assistant',
    content: 'Here is your dashboard.',
    streamState: stateOf([
      { name: 'write_html_document', args: { title: 'Paris Weather Dashboard', html: '<p>' } },
      { name: 'web_fetch', args: { url: 'https://api.open-meteo.com/v1/forecast' } },
    ]),
  };

  it('names each reply by the request it answered, with the documents it wrote', () => {
    const prompt = toolHistoryDeveloperPrompt(
      [
        { id: 'm-1', role: 'user', content: 'Build a Paris weather dashboard' },
        wrote,
        { id: 'm-2', role: 'user', content: 'thanks' },
        { id: 'm-3', role: 'assistant', content: 'You are welcome.', streamState: stateOf([]) },
      ],
      listed,
    );
    expect(prompt).toContain(
      `- Your reply to "Build a Paris weather dashboard": write_html_document: created HTML document "Paris Weather Dashboard" (artifact_id ${ARTIFACT_ID}); web_fetch: https://api.open-meteo.com/v1/forecast.`,
    );
    expect(prompt).toContain('Findings and links in those replies came from the real results.');
    expect(prompt).not.toContain('thanks');
  });

  it('is undefined when no reply called a tool', () => {
    expect(toolHistoryDeveloperPrompt([{ id: 'm-1', role: 'user', content: 'hi' }])).toBeUndefined();
  });
});

describe('historyContentForTurn', () => {
  it('keeps the tool record out of the assistant text, and strips one an earlier build left there', () => {
    const turn: ChatTurn = {
      id: 'msg-assistant-1',
      role: 'assistant',
      content:
        '[App record of the tools you called in this reply: update_slots. These calls really happened; their results are not repeated here.]\n\nJ’ai ajouté l’étiquette.',
      streamState: stateOf([{ name: 'update_slots', args: { slide_id: 's4' } }]),
    };
    expect(historyContentForTurn(turn)).toBe('J’ai ajouté l’étiquette.');
  });

  it('leaves user turns and tool-free turns as they are', () => {
    expect(historyContentForTurn({ id: 'm-1', role: 'user', content: 'make a guide' })).toBe('make a guide');
    expect(historyContentForTurn({ id: 'm-2', role: 'assistant', content: 'Hello.', streamState: stateOf([]) })).toBe(
      'Hello.',
    );
  });

  it('survives an app restart: a hydrated turn still names the document it wrote', async () => {
    vi.mocked(getRequestProviderEvents).mockResolvedValueOnce(
      callEvents([{ name: 'write_html_document', args: { title: 'Paris Weather Dashboard', html: '<p>' } }], 'req-9'),
    );
    const message: Message = {
      id: 'msg-assistant-1',
      conversationId: 'c1',
      role: 'assistant',
      requestId: 'req-9',
      parts: [],
      createdAt: '2026-10-09T10:00:01.000Z',
    };
    const turn = await hydrateAssistantTurn(message);
    expect(turn).not.toBeNull();
    const request = buildProviderRequest(settings, 'nice, can you make a nice chart in it?', [turn!], 'c1', [], undefined, null, {
      artifacts: listed,
    });
    expect(request.developerPrompt).toContain(`(artifact_id ${ARTIFACT_ID})`);
    // A turn with no text of its own is still dropped from the messages.
    expect(request.messages.find((m) => m.id === 'msg-assistant-1')).toBeUndefined();
  });
});
