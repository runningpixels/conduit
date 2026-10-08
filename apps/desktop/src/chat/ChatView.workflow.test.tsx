import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, Message } from '@conduit/config-schema';
import { ChatView } from './ChatView';

/// A chat the workflows touch: a message a workflow sent reads "From <name>"
/// instead of its text, and a workflow that adds messages to the open chat
/// refreshes the thread.

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
  pickWorkspaceFolder: vi.fn(),
  setConversationWorkspace: vi.fn(),
  getConnectorRuntimeStates: vi.fn().mockResolvedValue([]),
  listConnectorCapabilities: vi.fn().mockResolvedValue([]),
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
  listProviderModels: vi.fn().mockResolvedValue([
    { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' },
  ]),
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
  startResearch: vi.fn(),
  getResearchRun: vi.fn(),
  approveResearchBrief: vi.fn(),
  stopResearch: vi.fn(),
  cancelResearch: vi.fn(),
  openExternalUrl: vi.fn(),
  getDraftResearchMaterial: vi.fn().mockResolvedValue([]),
}));

import { getConversationMessages, getMessageIdByRequest, startChatStream } from '../ipc/client';


function message(id: string, role: 'user' | 'assistant', text: string, metadata?: Record<string, unknown>): Message {
  return {
    id,
    conversationId: 'conv-1',
    role,
    parts: [{ id: `${id}-p`, messageId: id, index: 0, kind: 'text', content: text, createdAt: '2026-10-01T00:00:00Z' }],
    ...(metadata ? { metadata } : {}),
    createdAt: '2026-10-01T00:00:00Z',
  } as Message;
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
      compact
      {...extra}
    />
  );
}

describe('ChatView and workflows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
  });

  it('labels a message a workflow sent "From <name>" and hides its instructions', async () => {
    vi.mocked(getConversationMessages).mockResolvedValue([
      message('m1', 'user', ["Update slide 3's chart.", '<input>a,b', '1,2</input>'].join('\n'), {
        workflow: { id: 'w1', runId: 'r1', name: 'Weekly numbers' },
      }),
      message('m2', 'assistant', 'Updated the chart.'),
      message('m3', 'user', 'Thanks, now shorten slide 2.'),
    ]);
    render(chat());
    const label = await screen.findByText('From Weekly numbers');
    expect(label.closest('.app-note')).not.toBeNull();
    expect(screen.queryByText(/Update slide 3/)).toBeNull();
    // An ordinary message of the user's stays as typed.
    expect(screen.getByText('Thanks, now shorten slide 2.')).toBeInTheDocument();
    expect(screen.getByText('Updated the chart.')).toBeInTheDocument();
  });

  it('ignores workflow metadata without a name', async () => {
    vi.mocked(getConversationMessages).mockResolvedValue([message('m1', 'user', 'Typed by hand.', { workflow: { id: 'w1' } })]);
    render(chat());
    expect(await screen.findByText('Typed by hand.')).toBeInTheDocument();
    expect(screen.queryByText(/^From /)).toBeNull();
  });

  it('shows the thread note with its action', async () => {
    const onClick = vi.fn();
    render(chat({ threadNote: 'Updated by Weekly numbers', threadAction: { label: 'Reload', onClick } }));
    expect(await screen.findByText('Updated by Weekly numbers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('reads the open thread again when a workflow added messages', async () => {
    vi.mocked(getConversationMessages).mockResolvedValue([message('m1', 'user', 'Hello there.')]);
    const view = render(chat({ threadRefresh: 0 }));
    expect(await screen.findByText('Hello there.')).toBeInTheDocument();
    vi.mocked(getConversationMessages).mockResolvedValue([
      message('m1', 'user', 'Hello there.'),
      message('m2', 'user', 'Add a section.', { workflow: { id: 'w1', runId: 'r2', name: 'Monthly report' } }),
    ]);
    view.rerender(chat({ threadRefresh: 1 }));
    expect(await screen.findByText('From Monthly report')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(getConversationMessages).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('names the model a workflow ran with, not the one selected now', async () => {
    vi.mocked(getConversationMessages).mockResolvedValue([
      message('m1', 'user', 'Hello.'),
      message('m2', 'assistant', 'Hi.'),
      message('m3', 'user', 'Update slide 3.', {
        workflow: { id: 'w1', runId: 'r1', name: 'Weekly numbers', model: { provider: 'openai', model: 'gpt-4.1-mini' } },
      }),
      message('m4', 'assistant', 'Updated the chart.'),
    ]);
    render(chat());
    await screen.findByText('Updated the chart.');
    const line = document.querySelector('.turn-model');
    expect(line?.textContent).toContain('gpt-4.1-mini');
    expect(document.querySelectorAll('.turn-model')).toHaveLength(1);
  });

  it('takes a refused send back out of the thread and returns the text to the composer', async () => {
    vi.mocked(startChatStream).mockRejectedValue(
      new Error('The workflow “Weekly numbers” is updating this right now. Try again when it has finished.'),
    );
    render(chat());
    const box = await screen.findByLabelText('Message the active provider');
    fireEvent.change(box, { target: { value: 'Shorten slide 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(startChatStream).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText('Message the active provider')).toHaveValue('Shorten slide 2'));
    // The user bubble is gone; the refusal is still shown.
    expect(screen.queryByText('Shorten slide 2', { ignore: 'textarea' })).toBeNull();
    expect(await screen.findAllByText(/is updating this right now/)).not.toHaveLength(0);
  });

  it('leaves other failed sends in the thread', async () => {
    vi.mocked(startChatStream).mockRejectedValue(new Error('Bad API key'));
    render(chat());
    fireEvent.change(await screen.findByLabelText('Message the active provider'), { target: { value: 'Hello again' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(startChatStream).toHaveBeenCalled());
    expect(await screen.findAllByText(/Bad API key/)).not.toHaveLength(0);
    expect(screen.getByLabelText('Message the active provider')).toHaveValue('');
    expect(screen.getByText('Hello again')).toBeInTheDocument();
  });
});
