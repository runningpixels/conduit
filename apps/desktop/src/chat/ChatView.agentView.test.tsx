import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppSettings, ConnectorRuntimeEvent, ProviderEvent } from '@conduit/config-schema';
import { ChatView } from './ChatView';

/// The agent view: a hand-off is one line in the reply, and opening it swaps
/// the thread for that helper's own transcript, live, with a breadcrumb back.

const baseSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  language: 'system',
  providerEndpoints: {},
  modelPriceOverrides: [],
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  artifactNetworkEnabled: true,
  closeToTray: false,
  closeToTrayOffered: false,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  updatePolicy: 'manual' as const,
  onboardingCompleted: true,
  examplesSeeded: false,
  webSearchEnabled: false,
  webSearch: {
    mode: 'auto' as const,
    localBackend: 'duckduckgo',
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
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

vi.mock('../ipc/client', () => ({
  getConversationMessages: vi.fn().mockResolvedValue([]),
  getConversationCompaction: vi.fn().mockResolvedValue(null),
  compactConversation: vi.fn().mockResolvedValue(null),
  getConversation: vi.fn().mockResolvedValue({
    id: 'conv-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }),
  getActiveTurn: vi.fn().mockResolvedValue(null),
  pickWorkspaceFolder: vi.fn(),
  setConversationWorkspace: vi.fn(),
  getConnectorRuntimeStates: vi.fn().mockResolvedValue([]),
  listConnectorCapabilities: vi.fn().mockResolvedValue([]),
  listConnectorPrompts: vi.fn().mockResolvedValue([]),
  listConnectorResources: vi.fn().mockResolvedValue([]),
  loadProviderCredentialReference: vi.fn().mockResolvedValue({
    providerId: 'anthropic',
    credentialRef: 'keychain://conduit/anthropic',
    storedInKeychain: true,
  }),
  listProviderDescriptors: vi.fn().mockResolvedValue([
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      defaultBaseUrl: null,
      credentialMode: 'required',
      isLocal: false,
      showBaseUrlField: false,
      tier: 0,
      description: null,
    },
  ]),
  listProviderModels: vi.fn().mockResolvedValue([{ id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' }]),
  resolveModelPrices: vi.fn().mockResolvedValue([]),
  updateSettings: vi.fn().mockImplementation(async (settings: AppSettings) => settings),
  saveAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  getArtifact: vi.fn(),
  startChatStream: vi.fn(),
  cancelChatStream: vi.fn(),
  getMessageIdByRequest: vi.fn(),
  discoverConnector: vi.fn(),
  startConnector: vi.fn(),
  invokeConnectorTool: vi.fn(),
  listSkills: vi.fn().mockResolvedValue([]),
  listConversationSkills: vi.fn().mockResolvedValue([]),
  setConversationSkills: vi.fn().mockResolvedValue([]),
  getSkillPromptBlock: vi.fn().mockResolvedValue(''),
  getMemoryPromptBlock: vi.fn().mockResolvedValue(''),
  listKnowledgeCollections: vi.fn().mockResolvedValue([]),
  listConversationCollections: vi.fn().mockResolvedValue([]),
  listConversationExcludedDocuments: vi.fn().mockResolvedValue([]),
  setConversationDocumentExcluded: vi.fn().mockResolvedValue([]),
  listKnowledgeDocuments: vi.fn().mockResolvedValue([]),
  retrieveKnowledgeContext: vi.fn().mockResolvedValue({
    text: '',
    citations: [],
    refusedTitles: [],
    unavailableCollections: [],
  }),
  saveDroppedAttachment: vi.fn(),
  attachmentDelivery: vi.fn().mockResolvedValue({ kind: 'text' }),
  prepareMessageEdit: vi.fn(),
  removeLastTurn: vi.fn().mockResolvedValue(1),
  openExternalUrl: vi.fn(),
  getDraftResearchMaterial: vi.fn().mockResolvedValue([]),
  redirectAgentCall: vi.fn(),
  stopAgentCall: vi.fn(),
  notifyUser: vi.fn(),
  approveConnectorToolCall: vi.fn(),
  denyConnectorToolCall: vi.fn(),
  listLibraryAgents: vi.fn().mockResolvedValue([]),
  createRoutine: vi.fn(),
  approveWorkflowPermissions: vi.fn(),
  setWorkflowSchedule: vi.fn(),
  deleteWorkflow: vi.fn(),
}));

import {
  createRoutine,
  getConversationMessages,
  getMessageIdByRequest,
  notifyUser,
  redirectAgentCall,
  setWorkflowSchedule,
  startChatStream,
} from '../ipc/client';

const ev = (event: unknown) => event as ProviderEvent;

/// A send whose events the test delivers by hand.
function captureStream() {
  const stream = {
    requestId: '',
    emit: (_e: ProviderEvent) => {},
    runtime: (_e: ConnectorRuntimeEvent) => {},
  };
  vi.mocked(startChatStream).mockImplementation(async (request, onEvent, onRuntimeEvent) => {
    stream.requestId = request.requestId;
    stream.emit = onEvent;
    stream.runtime = onRuntimeEvent ?? (() => {});
    return { requestId: request.requestId };
  });
  return stream;
}

function chat(extra: Partial<React.ComponentProps<typeof ChatView>> = {}) {
  return (
    <ChatView
      settings={baseSettings}
      onSelectModel={vi.fn()}
      onStatus={vi.fn()}
      conversationId="conv-1"
      artifacts={[]}
      fileStateMap={{}}
      onPromoteArtifact={vi.fn()}
      onOpenArtifact={vi.fn()}
      {...extra}
    />
  );
}

async function send(text: string) {
  const box = await screen.findByLabelText('Message the active provider');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await waitFor(() => expect(startChatStream).toHaveBeenCalled());
}

/// Hand-off events of the live turn.
function helpers(stream: ReturnType<typeof captureStream>) {
  const r = () => stream.requestId;
  const emit = (e: unknown) => act(() => stream.emit(ev(e)));
  const started = (id: string, name: string, task: string, callId: string) => ({
    kind: 'handoffStarted',
    requestId: r(),
    toolCallId: id,
    agentId: name.toLowerCase(),
    name,
    task,
    model: 'anthropic/claude-haiku',
    callId,
    helperRequestId: `h-${id}`,
  });
  const inner = (id: string, event: unknown) => ({ kind: 'handoff', requestId: r(), toolCallId: id, event });
  const text = (blockId: string, content: string) => [
    { kind: 'contentBlockStart', requestId: 'h', blockId, index: 0, blockKind: 'text' },
    { kind: 'contentDelta', requestId: 'h', blockId, index: 1, content },
  ];
  return {
    start: (id: string, name: string, task: string, callId: string) => emit(started(id, name, task, callId)),
    say: (id: string, blockId: string, content: string) => {
      for (const e of text(blockId, content)) emit(inner(id, e));
    },
    nested: (outer: string, id: string, name: string, task: string, callId: string) =>
      emit(inner(outer, started(id, name, task, callId))),
    finish: (id: string, status = 'done') =>
      emit({ kind: 'handoffFinished', requestId: r(), toolCallId: id, status, tokens: 900, error: null, answer: 'All done.' }),
    toolStart: (id: string, toolId: string, name: string) =>
      emit(inner(id, { kind: 'toolCallStart', requestId: 'h', toolCallId: toolId, index: 0, toolId: name, name })),
    complete: () => emit({ kind: 'messageComplete', requestId: r(), index: 99, finishReason: 'stop' }),
  };
}

function lineFor(name: string) {
  return screen.getByRole('button', { name: new RegExp(`^Open ${name}:`) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
  vi.mocked(redirectAgentCall).mockResolvedValue(undefined);
});

describe('hand-offs in the main thread', () => {
  it('shows one line per helper, under "Waiting for 2 agents"', async () => {
    const stream = captureStream();
    render(chat());
    await send('Compare prices');
    const h = helpers(stream);
    h.start('tc1', 'Researcher', 'Germany prices', 'call-1');
    h.start('tc2', 'Writer', 'Draft the summary', 'call-2');
    h.say('tc1', 'b0', 'Looking at the shops.');
    expect(await screen.findByText('Waiting for 2 agents')).toBeInTheDocument();
    expect(lineFor('Researcher')).toBeInTheDocument();
    expect(lineFor('Writer')).toBeInTheDocument();
    // The helper's own text stays in its view.
    expect(screen.queryByText('Looking at the shops.')).toBeNull();
  });
});

describe('the agent view', () => {
  async function openResearcher() {
    const stream = captureStream();
    const onStatus = vi.fn();
    const view = render(chat({ onStatus }));
    await send('Compare prices');
    const h = helpers(stream);
    h.start('tc1', 'Researcher', 'Germany prices', 'call-1');
    h.start('tc2', 'Writer', 'Draft the summary', 'call-2');
    h.say('tc1', 'b0', 'Looking at the shops.');
    fireEvent.click(await waitFor(() => lineFor('Researcher')));
    return { stream, h, onStatus, view };
  }

  it('opens in place of the thread, with a breadcrumb, header and the main chat strip', async () => {
    await openResearcher();
    const crumbs = screen.getByRole('navigation', { name: 'Where you are' });
    expect(within(crumbs).getByRole('button', { name: 'Chat' })).toBeInTheDocument();
    expect(within(crumbs).getByRole('button', { name: 'Researcher · Germany prices' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeInTheDocument();
    expect(screen.getByText('Looking at the shops.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop Researcher' })).toBeInTheDocument();
    expect(screen.getByText('Main chat: waiting for 2 agents')).toBeInTheDocument();
    // The main thread is not shown meanwhile.
    expect(screen.queryByText('Compare prices')).toBeNull();
  });

  it('stays live as the helper works', async () => {
    const { h } = await openResearcher();
    h.say('tc1', 'b1', 'Found three shops.');
    expect(await screen.findByText('Found three shops.')).toBeInTheDocument();
  });

  it('opens a nested helper one level deeper and goes back by the breadcrumb', async () => {
    const { h } = await openResearcher();
    h.nested('tc1', 'tc3', 'Checker', 'Check the numbers', 'call-3');
    fireEvent.click(lineFor('Checker'));
    const crumbs = screen.getByRole('navigation', { name: 'Where you are' });
    expect(within(crumbs).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Back',
      'Chat',
      'Researcher · Germany prices',
      'Checker · Check the numbers',
    ]);
    fireEvent.click(within(crumbs).getByRole('button', { name: 'Researcher · Germany prices' }));
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(lineFor('Researcher')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Where you are' })).toBeNull();
  });

  it('goes back on Escape, but not while the composer holds text', async () => {
    await openResearcher();
    const box = screen.getByLabelText('Message the active provider');
    fireEvent.change(box, { target: { value: 'half a thought' } });
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '' } });
    const parent = vi.fn();
    window.addEventListener('keydown', parent);
    fireEvent.keyDown(box, { key: 'Escape' });
    window.removeEventListener('keydown', parent);
    expect(screen.queryByRole('heading', { name: 'Researcher' })).toBeNull();
    expect(lineFor('Researcher')).toBeInTheDocument();
    // The key stopped here: the shell's own Escape never saw it.
    expect(parent).not.toHaveBeenCalled();
  });

  it('leaves Escape to an open dialog', async () => {
    await openResearcher();
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeInTheDocument();
    dialog.remove();
  });

  it('sends the composer to the running helper and notes it', async () => {
    await openResearcher();
    const box = screen.getByLabelText('Message the active provider');
    expect(box).toHaveAttribute('placeholder', 'Tell Researcher what to do…');
    fireEvent.change(box, { target: { value: 'Use primary sources' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(redirectAgentCall).toHaveBeenCalledWith('call-1', 'Use primary sources'));
    expect(await screen.findByText('You: Use primary sources')).toBeInTheDocument();
    expect(box).toHaveValue('');
    expect(startChatStream).toHaveBeenCalledTimes(1);
  });

  it('says so in the view when the message did not reach the helper', async () => {
    vi.mocked(redirectAgentCall).mockRejectedValue(new Error('gone'));
    await openResearcher();
    const box = screen.getByLabelText('Message the active provider');
    fireEvent.change(box, { target: { value: 'Stop early' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/Researcher may have just finished/)).toBeInTheDocument();
    expect(box).toHaveValue('Stop early');
  });

  it('once the helper finished, the composer writes to the chat again', async () => {
    const { h } = await openResearcher();
    h.finish('tc1');
    h.finish('tc2');
    h.complete();
    await waitFor(() => expect(screen.getByText('Main chat replied')).toBeInTheDocument());
    const box = screen.getByLabelText('Message the active provider');
    expect(box).not.toHaveAttribute('placeholder', 'Tell Researcher what to do…');
    fireEvent.change(box, { target: { value: 'Thanks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(startChatStream).toHaveBeenCalledTimes(2));
    expect(redirectAgentCall).not.toHaveBeenCalled();
    // Back on the main thread.
    expect(screen.queryByRole('navigation', { name: 'Where you are' })).toBeNull();
  });

  it('opens a helper by its call id when the shell asks', async () => {
    const stream = captureStream();
    const onConsumed = vi.fn();
    const view = render(chat({ onPendingAgentViewConsumed: onConsumed }));
    await send('Compare prices');
    const h = helpers(stream);
    h.start('tc1', 'Researcher', 'Germany prices', 'call-1');
    h.nested('tc1', 'tc3', 'Checker', 'Check the numbers', 'call-3');
    view.rerender(
      chat({
        onPendingAgentViewConsumed: onConsumed,
        pendingAgentView: { conversationId: 'conv-1', callId: 'call-3', nonce: 1 },
      }),
    );
    expect(await screen.findByRole('heading', { name: 'Checker' })).toBeInTheDocument();
    expect(onConsumed).toHaveBeenCalled();
  });

  it('reports the helper being watched', async () => {
    const stream = captureStream();
    const onAgentViewChange = vi.fn();
    render(chat({ onAgentViewChange }));
    await send('Compare prices');
    helpers(stream).start('tc1', 'Researcher', 'Germany prices', 'call-1');
    fireEvent.click(await waitFor(() => lineFor('Researcher')));
    expect(onAgentViewChange).toHaveBeenLastCalledWith({ conversationId: 'conv-1', callId: 'call-1' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onAgentViewChange).toHaveBeenLastCalledWith(null);
  });
});

describe("a helper's approval", () => {
  it('shows on its line and toasts once, with Review opening its view', async () => {
    const stream = captureStream();
    const onStatus = vi.fn();
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    render(chat({ onStatus }));
    await send('Post it');
    const h = helpers(stream);
    h.start('tc1', 'Researcher', 'Post the results', 'call-1');
    h.toolStart('tc1', 'inner1', 'Echo__post');
    const consent = {
      kind: 'consentRequested',
      prompt: {
        toolCallId: 'inner1',
        connectorVersionId: 'echo:1',
        connectorName: 'Echo',
        toolName: 'post',
        arguments: {},
        permissionLevel: 'sideEffectful',
        toolDescription: '',
        dataSummary: '',
        consentCopy: null,
      },
    } as unknown as ConnectorRuntimeEvent;
    act(() => stream.runtime(consent));
    expect(await screen.findByText('Needs your approval')).toBeInTheDocument();
    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ brief: 'Researcher needs your approval' })),
    );
    expect(notifyUser).toHaveBeenCalledWith('Researcher needs your approval', 'Post the results');
    // Once per tool call.
    h.say('tc1', 'b0', 'Waiting.');
    const toasts = onStatus.mock.calls.filter(([s]) => s?.brief === 'Researcher needs your approval');
    expect(toasts).toHaveLength(1);
    act(() => toasts[0][0].action.run());
    expect(screen.getByRole('heading', { name: 'Researcher' })).toBeInTheDocument();
    // The approval card waits in the view.
    expect(document.querySelector('.consent')).not.toBeNull();
    focus.mockRestore();
  });
});

describe('a reply one of your agents gave', () => {
  it('offers "Schedule this…" in its actions, which opens the routine form with that agent, the message and a name', async () => {
    vi.mocked(getConversationMessages).mockResolvedValue([
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        metadata: { agent: { id: 'researcher', name: 'Researcher' } },
        parts: [
          {
            id: 'u1-p0',
            messageId: 'u1',
            index: 0,
            kind: 'text',
            content: 'Brief me on EU energy prices',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        parts: [{ id: 'a1-p0', messageId: 'a1', index: 0, kind: 'text', content: 'Prices fell 3%.', createdAt: '2026-01-01T00:00:01Z' }],
        createdAt: '2026-01-01T00:00:01Z',
      },
    ] as never);
    vi.mocked(createRoutine).mockResolvedValue({
      workflow: { id: 'wf-1' },
      permissions: { required: [], missing: [], approvedAt: null },
    } as never);
    vi.mocked(setWorkflowSchedule).mockResolvedValue(null);
    const onStatus = vi.fn();
    render(chat({ onStatus }));
    await screen.findByText('Prices fell 3%.');
    // Once, in the reply's actions (not on the message).
    const buttons = screen.getAllByRole('button', { name: 'Schedule this…' });
    expect(buttons).toHaveLength(1);
    expect(buttons[0].closest('.turn.assistant')).not.toBeNull();
    fireEvent.click(buttons[0]);
    const dialog = await screen.findByRole('dialog', { name: 'Run Researcher on a schedule' });
    expect(within(dialog).getByLabelText('What to do each time')).toHaveValue('Brief me on EU energy prices');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Brief me on EU energy prices');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setWorkflowSchedule).toHaveBeenCalledWith('wf-1', { kind: 'weekdays', time: '08:00' }, true));
    expect(createRoutine).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'researcher', task: 'Brief me on EU energy prices' }),
    );
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ brief: 'Researcher will do this on schedule.' }));
    expect(screen.queryByRole('dialog', { name: 'Run Researcher on a schedule' })).toBeNull();
  });

  it('does not offer it on a reply from the assistant', async () => {
    vi.mocked(getConversationMessages).mockResolvedValue([
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        parts: [
          { id: 'u1-p0', messageId: 'u1', index: 0, kind: 'text', content: 'Hello', createdAt: '2026-01-01T00:00:00Z' },
        ],
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        parts: [{ id: 'a1-p0', messageId: 'a1', index: 0, kind: 'text', content: 'Hi there.', createdAt: '2026-01-01T00:00:01Z' }],
        createdAt: '2026-01-01T00:00:01Z',
      },
    ] as never);
    render(chat());
    await screen.findByText('Hi there.');
    expect(screen.queryByRole('button', { name: 'Schedule this…' })).toBeNull();
  });
});
