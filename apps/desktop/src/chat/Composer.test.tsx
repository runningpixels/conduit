import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createRef, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type { AppSettings } from '@conduit/config-schema';
import { Composer, type ComposerHandle } from './Composer';
import { COMPOSER_MAX_HEIGHT_PX } from './composerTypes';
import type { ConnectorPromptInfo, ConnectorResourceInfo } from '../ipc/contracts';

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
};

vi.mock('../ipc/client', () => ({
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
    {
      id: 'openai',
      displayName: 'OpenAI',
      defaultBaseUrl: null,
      credentialMode: 'required',
      isLocal: false,
      showBaseUrlField: false,
      tier: 0,
      description: null,
    },
  ]),
  // Per-provider, not one shared list: the menu groups by provider, so a mock
  // returning the same models for both would render duplicate rows and make
  // every by-name query ambiguous.
  // The backend's price resolution, reduced to the one model these tests price.
  resolveModelPrices: vi.fn(async (_provider: string, modelIds: string[]) =>
    modelIds.map((id) =>
      id === 'claude-sonnet-4' ? { price: { inputPerMtok: 3, outputPerMtok: 15 }, source: 'snapshot' } : null,
    ),
  ),
  listProviderModels: vi.fn().mockImplementation(async (id: string) =>
    id === 'openai'
      ? [{ id: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini' }]
      : [
          { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' },
          { id: 'claude-opus-4', displayName: 'Claude Opus 4' },
        ],
  ),
  updateSettings: vi.fn().mockImplementation(async (settings: AppSettings) => settings),
  saveAttachment: vi.fn().mockResolvedValue({
    id: 'att-1',
    conversationId: 'conv-1',
    path: 'ab/cd',
    mimeType: 'text/plain',
    sizeBytes: 5,
    retentionState: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    origin: 'notes.txt',
  }),
  deleteAttachment: vi.fn().mockResolvedValue(undefined),
  attachmentDelivery: vi.fn().mockResolvedValue({ kind: 'text' }),
  saveDroppedAttachment: vi.fn().mockResolvedValue({
    id: 'att-dropped-1',
    conversationId: 'conv-1',
    path: 'ab/dropped',
    mimeType: 'text/plain',
    sizeBytes: 5,
    retentionState: 'active',
    createdAt: '2026-01-01T00:00:00Z',
    origin: 'dropped.txt',
  }),
  listKnowledgeDocuments: vi.fn().mockResolvedValue([]),
}));

const collection = {
  id: 'c1',
  name: 'Greenhouse',
  providerId: 'openrouter',
  embeddingModel: 'openai/text-embedding-3-small',
  embeddingDimensions: 1536,
  documentCount: 2,
  createdAt: '2026-09-20T00:00:00Z',
  updatedAt: '2026-09-20T00:00:00Z',
};

function skill(id: string, name: string) {
  return {
    id,
    name,
    description: '',
    source: 'conduit' as const,
    path: `/skills/${id}`,
    hasScripts: false,
    hasReferences: false,
    hasAssets: false,
  };
}

const resource = {
  connectorVersionId: 'echo:1.0.0',
  connectorName: 'Echo',
  name: 'spec.md',
  uri: 'echo://notes/spec.md',
  description: undefined,
  stale: false,
  discoveredAt: '2026-09-15T00:00:00Z',
} as unknown as ConnectorResourceInfo;

const mcpPrompt = {
  connectorVersionId: 'echo:1.0.0',
  connectorName: 'Echo',
  name: 'summarize',
  description: 'Summarize a document',
  arguments: [],
  stale: false,
  discoveredAt: '2026-09-15T00:00:00Z',
} as unknown as ConnectorPromptInfo;

const plusButton = () => screen.getByRole('button', { name: 'Add to this message' });

function openPlusMenu() {
  fireEvent.click(plusButton());
  return screen.getByRole('menu', { name: 'Add to this message' });
}

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn();
  const onStop = vi.fn();
  const onPromptChange = vi.fn();
  const onSelectModel = vi.fn();
  const onWebSearchToggle = vi.fn();

  render(
    <Composer
      settings={baseSettings}
      onSelectModel={onSelectModel}
      conversationId="conv-1"
      prompt=""
      onPromptChange={onPromptChange}
      onSend={onSend}
      onStop={onStop}
      streaming={false}
      webSearchOn={false}
      onWebSearchToggle={onWebSearchToggle}
      {...overrides}
    />,
  );

  return { onSend, onStop, onPromptChange, onSelectModel, onWebSearchToggle };
}

describe('Composer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        const lines = this.value ? this.value.split('\n').length : 1;
        return lines * 24;
      },
    });
  });

  /**
   * t1-6 acceptance criterion 13: a user who has never made a knowledge base
   * collection must see no new composer control at all.
   *
   * This shipped wrong once. The button was gated only on the `onToggleCollection`
   * handler being wired, which it always is, so it appeared for everyone and
   * opened a popover that said "No collections yet". Every render test passed,
   * because the component was rendering exactly as written — it was only visible
   * by driving the real app with an empty database. The same gate now applies
   * to the "+" menu's Documents item.
   */
  it('hides the Documents item entirely when there are no collections', () => {
    renderComposer({ onToggleCollection: vi.fn(), collections: [] });
    openPlusMenu();
    expect(screen.queryByRole('menuitem', { name: /documents/i })).toBeNull();
  });

  it('shows the Documents item once a collection exists and opens its popover', () => {
    renderComposer({ onToggleCollection: vi.fn(), collections: [collection] });
    openPlusMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Documents…' }));
    expect(screen.getByRole('dialog', { name: 'Knowledge base collections' })).toBeInTheDocument();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('disables send on an empty prompt', () => {
    renderComposer({ prompt: '' });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('sends on Enter but not on Shift+Enter', () => {
    const { onSend } = renderComposer({ prompt: 'hello' });
    const textarea = screen.getByLabelText('Message the active provider');

    expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('caps textarea growth and marks the field as scrollable', async () => {
    const longPrompt = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');
    renderComposer({ prompt: longPrompt });

    const textarea = screen.getByLabelText('Message the active provider') as HTMLTextAreaElement;

    await waitFor(() => {
      expect(textarea.dataset.capped).toBe('true');
      expect(textarea.style.overflowY).toBe('auto');
      expect(parseInt(textarea.style.height, 10)).toBeLessThanOrEqual(COMPOSER_MAX_HEIGHT_PX);
    });
  });

  it('opens the model menu grouped by provider and picks a model', async () => {
    const { onSelectModel } = renderComposer();

    fireEvent.click(screen.getByTitle('Switch model'));

    // Group captions carry the provider's key posture, not just its name.
    expect(await screen.findByText('Anthropic · keychain')).toBeInTheDocument();
    expect(screen.getByText('OpenAI · keychain')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('menuitem', { name: /Claude Opus 4/ }));

    // One write, carrying provider and model together.
    expect(onSelectModel).toHaveBeenCalledTimes(1);
    expect(onSelectModel).toHaveBeenCalledWith('anthropic', 'claude-opus-4', null);
  });

  it('marks the active model and shows its price tail', async () => {
    renderComposer();
    fireEvent.click(screen.getByTitle('Switch model'));

    const active = await screen.findByRole('menuitem', { name: /Claude Sonnet 4/ });
    expect(active).toHaveAttribute('aria-current', 'true');
    // Prices are resolved by the backend after the models arrive.
    await waitFor(() => expect(active).toHaveTextContent('$3 / $15'));
  });

  it('keeps an unreachable provider selectable instead of hiding it', async () => {
    const { listProviderModels } = await import('../ipc/client');
    // Risk R6: an unreachable provider costs its own rows and nothing else — but
    // it keeps its group, degraded to the typed-id row. Dropping the group would
    // make the provider unpickable from the composer, which is a capability
    // loss rather than a graceful degradation.
    vi.mocked(listProviderModels).mockImplementation(async (id: string) => {
      if (id === 'openai') throw new Error('connection refused');
      return [
        { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' },
        { id: 'claude-opus-4', displayName: 'Claude Opus 4' },
      ];
    });

    renderComposer();
    fireEvent.click(screen.getByTitle('Switch model'));

    expect(await screen.findByText('Anthropic · keychain')).toBeInTheDocument();
    expect(screen.getByText('Claude Opus 4')).toBeInTheDocument();
    expect(screen.getByText('OpenAI · keychain')).toBeInTheDocument();
    expect(screen.getByLabelText('Model id for OpenAI')).toBeInTheDocument();
  });

  it('uploads attachments, shows chips, and removes them', async () => {
    const { saveAttachment, deleteAttachment } = await import('../ipc/client');
    renderComposer();

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    await waitFor(() => expect(saveAttachment).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    await waitFor(() => expect(deleteAttachment).toHaveBeenCalledWith('att-1'));
    expect(screen.queryByText('notes.txt')).toBeNull();
  });

  it('surfaces upload failures with retry affordance', async () => {
    const { saveAttachment } = await import('../ipc/client');
    vi.mocked(saveAttachment).mockRejectedValueOnce(new Error('Upload failed'));

    renderComposer();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'broken.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry broken.txt' })).toBeInTheDocument();
  });

  /** D12: the scout found `Composer.handleKeyDown` had no `isComposing`
   *  guard, so the Enter that confirms a Japanese/Korean/Chinese IME
   *  conversion sent the message. */
  it('does not send on the Enter that confirms an IME composition', () => {
    const { onSend } = renderComposer({ prompt: 'こんにちは' });
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
    // An ordinary Enter afterwards still sends.
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('also honours the keyCode 229 IME fallback', () => {
    const { onSend } = renderComposer({ prompt: 'hello' });
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.keyDown(textarea, { key: 'Enter', keyCode: 229 });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('exposes focusPrompt via ref', () => {
    const ref = createRef<ComposerHandle>();
    renderComposer({ ref });
    const textarea = screen.getByLabelText('Message the active provider');
    expect(document.activeElement).not.toBe(textarea);
    ref.current?.focusPrompt();
    expect(document.activeElement).toBe(textarea);
  });
});

describe('Composer "+" menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const webSettings: AppSettings = { ...baseSettings, localOnly: false, webSearchEnabled: true };

  it('lists only the items whose feature is available', () => {
    renderComposer();
    openPlusMenu();
    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent);
    expect(labels).toEqual(['Attach files…']);
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
  });

  it('lists every item when every feature is wired and advertised', () => {
    renderComposer({
      settings: webSettings,
      onWorkspacePick: vi.fn(),
      onToggleCollection: vi.fn(),
      collections: [collection],
      onToggleSkill: vi.fn(),
      onPickMcpPrompt: vi.fn(),
      mcpPrompts: [mcpPrompt],
      onToggleMcpResource: vi.fn(),
      mcpResources: [resource],
      onSaveChatSettings: vi.fn(),
    });
    const menu = openPlusMenu();
    const labels = Array.from(menu.querySelectorAll('[role^="menuitem"]')).map(
      (item) => item.querySelector('span')?.textContent,
    );
    expect(labels).toEqual([
      'Attach files…',
      'Workspace folder…',
      'Documents…',
      'Skills…',
      'Connector prompts…',
      'Connector resources…',
      'Chat settings…',
    ]);
  });

  it('opens the file picker from Attach', () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    renderComposer();
    openPlusMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Attach files…' }));
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('disables Attach when there is no conversation yet', () => {
    renderComposer({ conversationId: null });
    openPlusMenu();
    expect(screen.getByRole('menuitem', { name: 'Attach files…' })).toBeDisabled();
  });

  it('disables the + button while a reply streams', () => {
    renderComposer({ streaming: true });
    expect(plusButton()).toBeDisabled();
  });

  it('no longer lists web search or Research: they are toggles in the bar', () => {
    renderComposer({ settings: { ...webSettings, webSearchConsentAcknowledged: true }, onResearchToggle: vi.fn() });
    openPlusMenu();
    expect(screen.queryByRole('menuitemcheckbox')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /web search|research/i })).toBeNull();
  });

  describe('keyboard', () => {
    function renderFull() {
      return renderComposer({
        settings: webSettings,
        onToggleSkill: vi.fn(),
        onSaveChatSettings: vi.fn(),
      });
    }

    it('focuses the first item on open and moves with the arrows, Home and End', () => {
      renderFull();
      const menu = openPlusMenu();
      const items = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
      expect(items).toHaveLength(3);
      expect(document.activeElement).toBe(items[0]);

      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(menu, { key: 'End' });
      expect(document.activeElement).toBe(items[2]);
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(menu, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(items[2]);
      fireEvent.keyDown(menu, { key: 'Home' });
      expect(document.activeElement).toBe(items[0]);
    });

    it('skips disabled items', () => {
      renderComposer({
        conversationId: null,
        onToggleSkill: vi.fn(),
        onPickMcpPrompt: vi.fn(),
        mcpPrompts: [mcpPrompt],
      });
      const menu = openPlusMenu();
      const prompts = screen.getByRole('menuitem', { name: 'Connector prompts…' });
      // Attach and Skills are disabled without a chat, so prompts is the only stop.
      expect(document.activeElement).toBe(prompts);
      fireEvent.keyDown(menu, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(prompts);
    });

    it('closes on Escape and returns focus to the + button', () => {
      renderFull();
      openPlusMenu();
      fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(plusButton());
      expect(plusButton()).toHaveAttribute('aria-expanded', 'false');
    });

    it('opens from the trigger with ArrowDown', () => {
      renderFull();
      plusButton().focus();
      fireEvent.keyDown(plusButton(), { key: 'ArrowDown' });
      expect(screen.getByRole('menu')).toBeInTheDocument();
      expect(document.activeElement).toBe(screen.getAllByRole('menuitem')[0]);
    });

    it('closes on a press outside', () => {
      renderFull();
      openPlusMenu();
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('toggles closed from the + button itself', () => {
      renderFull();
      openPlusMenu();
      fireEvent.pointerDown(plusButton());
      fireEvent.click(plusButton());
      expect(screen.queryByRole('menu')).toBeNull();
    });
  });

  describe('popovers', () => {
    it('opens the skills popover from the menu', () => {
      renderComposer({ onToggleSkill: vi.fn(), skills: [skill('s1', 'Research')] });
      openPlusMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Skills…' }));
      expect(screen.getByRole('dialog', { name: 'Skills for this chat' })).toBeInTheDocument();
    });

    it('keeps one popover open at a time', () => {
      renderComposer({ onToggleSkill: vi.fn(), onSaveChatSettings: vi.fn() });
      openPlusMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Skills…' }));
      openPlusMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Chat settings…' }));
      expect(screen.queryByRole('dialog', { name: 'Skills for this chat' })).toBeNull();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    });

    it('opens chat settings from the menu and from the imperative handle', () => {
      const ref = createRef<ComposerHandle>();
      renderComposer({ ref, onSaveChatSettings: vi.fn() });
      openPlusMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Chat settings…' }));
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      act(() => ref.current?.openChatSettings());
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    });

    it('opens connector prompts and resources only when advertised', () => {
      renderComposer({
        onPickMcpPrompt: vi.fn(),
        mcpPrompts: [mcpPrompt],
        onToggleMcpResource: vi.fn(),
        mcpResources: [],
      });
      openPlusMenu();
      expect(screen.queryByRole('menuitem', { name: 'Connector resources…' })).toBeNull();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Connector prompts…' }));
      expect(screen.getByRole('dialog', { name: 'MCP prompts' })).toBeInTheDocument();
    });

    it('picks the folder straight away when none is bound', () => {
      const onWorkspacePick = vi.fn();
      renderComposer({ onWorkspacePick });
      openPlusMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Workspace folder…' }));
      expect(onWorkspacePick).toHaveBeenCalledTimes(1);
    });

    it('opens the folder menu when a folder is bound', () => {
      const onWorkspacePick = vi.fn();
      renderComposer({ onWorkspacePick, onWorkspaceClear: vi.fn(), workspaceRoot: 'C:/work/garden' });
      openPlusMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Workspace folder…' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Change folder…' }));
      expect(onWorkspacePick).toHaveBeenCalledTimes(1);
    });
  });

  describe('context chips', () => {
    it('renders no chip row when nothing is active', () => {
      renderComposer({ onToggleSkill: vi.fn(), onWorkspacePick: vi.fn() });
      expect(screen.queryByRole('group', { name: 'Active in this chat' })).toBeNull();
    });

    it('shows the workspace folder by name and clears it', () => {
      const onWorkspaceClear = vi.fn();
      renderComposer({ onWorkspacePick: vi.fn(), onWorkspaceClear, workspaceRoot: 'C:/work/garden' });
      const row = screen.getByRole('group', { name: 'Active in this chat' });
      expect(row).toHaveTextContent('garden');
      fireEvent.click(screen.getByRole('button', { name: 'Stop using folder garden in this chat' }));
      expect(onWorkspaceClear).toHaveBeenCalledTimes(1);
    });

    it('shows the Settings default folder as the default, and its × turns it off', () => {
      const onWorkspaceClear = vi.fn();
      renderComposer({
        onWorkspacePick: vi.fn(),
        onWorkspaceClear,
        workspaceRoot: 'D:/Desktop/Chrome Downloads',
        workspaceFromSettings: true,
      });
      const row = screen.getByRole('group', { name: 'Active in this chat' });
      expect(row).toHaveTextContent('Chrome Downloads (default)');
      expect(row.querySelector('.composer-context-chip')).toHaveAttribute(
        'title',
        'Default folder from Settings: D:/Desktop/Chrome Downloads',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Chrome Downloads (default)' }));
      expect(screen.getByText(/Clearing it turns folder access off for this chat only/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Stop using folder Chrome Downloads in this chat' }));
      expect(onWorkspaceClear).toHaveBeenCalledTimes(1);
    });

    it('opens the folder menu from the folder chip', () => {
      renderComposer({ onWorkspacePick: vi.fn(), onWorkspaceClear: vi.fn(), workspaceRoot: 'C:/work/garden' });
      fireEvent.click(screen.getByRole('button', { name: 'garden' }));
      expect(screen.getByRole('menuitem', { name: 'Clear for this chat' })).toBeInTheDocument();
    });

    it('shows each attached collection and detaches it', () => {
      const onToggleCollection = vi.fn();
      renderComposer({ onToggleCollection, collections: [collection], enabledCollectionIds: ['c1'] });
      fireEvent.click(screen.getByRole('button', { name: 'Detach Greenhouse' }));
      expect(onToggleCollection).toHaveBeenCalledWith('c1', false);
    });

    it('opens the collections popover from a collection chip', () => {
      renderComposer({ onToggleCollection: vi.fn(), collections: [collection], enabledCollectionIds: ['c1'] });
      fireEvent.click(screen.getByRole('button', { name: 'Greenhouse' }));
      expect(screen.getByRole('dialog', { name: 'Knowledge base collections' })).toBeInTheDocument();
    });

    it('counts enabled skills and opens the skills popover from the chip', () => {
      renderComposer({
        onToggleSkill: vi.fn(),
        skills: [skill('s1', 'Research'), skill('s2', 'Review')],
        enabledSkillIds: ['s1', 's2'],
      });
      fireEvent.click(screen.getByRole('button', { name: '2 skills' }));
      expect(screen.getByRole('dialog', { name: 'Skills for this chat' })).toBeInTheDocument();
    });

    it('turns every enabled skill off from the skills chip', async () => {
      const writes: string[][] = [];
      // Mirrors ChatView: the toggle reads the current list from a ref that is
      // only updated on render, so two toggles in one tick would clobber each
      // other. The chip must hand them over one render at a time.
      function Harness() {
        const [ids, setIds] = useState(['s1', 's2']);
        const idsRef = useRef(ids);
        idsRef.current = ids;
        return (
          <Composer
            settings={baseSettings}
            onSelectModel={vi.fn()}
            conversationId="conv-1"
            prompt=""
            onPromptChange={vi.fn()}
            onSend={vi.fn()}
            onStop={vi.fn()}
            streaming={false}
            webSearchOn={false}
            onWebSearchToggle={vi.fn()}
            skills={[skill('s1', 'Research'), skill('s2', 'Review')]}
            enabledSkillIds={ids}
            onToggleSkill={(id, on) => {
              const next = on ? [...idsRef.current, id] : idsRef.current.filter((x) => x !== id);
              writes.push(next);
              setIds(next);
            }}
          />
        );
      }
      render(<Harness />);
      fireEvent.click(screen.getByRole('button', { name: 'Turn off 2 skills' }));
      await waitFor(() => expect(screen.queryByRole('group', { name: 'Active in this chat' })).toBeNull());
      expect(writes).toEqual([['s2'], []]);
    });

    it('shows attached connector resources and detaches them', () => {
      const onToggleMcpResource = vi.fn();
      renderComposer({
        onToggleMcpResource,
        mcpResources: [resource],
        attachedResources: [{ connectorVersionId: 'echo:1.0.0', name: 'spec.md', uri: 'echo://notes/spec.md' }],
      });
      fireEvent.click(screen.getByRole('button', { name: 'Detach spec.md' }));
      expect(onToggleMcpResource).toHaveBeenCalledWith(resource, false);
    });

    it('shows a chat settings override and resets it', () => {
      const onSaveChatSettings = vi.fn();
      renderComposer({ onSaveChatSettings, userInstructions: 'Be brief.' });
      fireEvent.click(screen.getByRole('button', { name: 'Reset chat settings to defaults' }));
      expect(onSaveChatSettings).toHaveBeenCalledWith(null, null);
    });

    it('keeps chips visible but locked while a reply streams', () => {
      renderComposer({
        settings: webSettings,
        webSearchOn: true,
        onToggleCollection: vi.fn(),
        collections: [collection],
        enabledCollectionIds: ['c1'],
        streaming: true,
      });
      expect(screen.getByRole('button', { name: 'Web' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Detach Greenhouse' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Greenhouse' })).toBeDisabled();
    });
  });
});

/** t1-8 M3: the `#` document-reference picker. Typing through a controlled
 * textarea needs the prompt fed back, so these use a small stateful harness
 * rather than `renderComposer`'s fixed `prompt` prop. */
function renderDocPickerHarness(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const onAddKnowledgeRef = vi.fn();
  const onSend = vi.fn();

  function Harness() {
    const [prompt, setPrompt] = useState('');
    return (
      <Composer
        settings={baseSettings}
        onSelectModel={vi.fn()}
        conversationId="conv-1"
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={onSend}
        onStop={vi.fn()}
        streaming={false}
        webSearchOn={false}
        onWebSearchToggle={vi.fn()}
        collections={[collection]}
        onAddKnowledgeRef={onAddKnowledgeRef}
        {...overrides}
      />
    );
  }
  render(<Harness />);
  return { onAddKnowledgeRef, onSend };
}

function knowledgeDoc(id: string, title: string) {
  return {
    id,
    collectionId: 'c1',
    source: `/greenhouse/${title}`,
    title,
    mimeType: 'text/plain',
    byteSize: 10,
    chunkCount: 1,
    importedAt: '2026-09-20T00:00:00Z',
  };
}

describe('Composer # document picker', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { listKnowledgeDocuments } = await import('../ipc/client');
    vi.mocked(listKnowledgeDocuments).mockResolvedValue([
      knowledgeDoc('d1', 'notes.md'),
      knowledgeDoc('d2', 'stale.md'),
    ]);
  });

  it('opens on #, filters by title, and Enter picks the active option', async () => {
    const { onAddKnowledgeRef } = renderDocPickerHarness();
    const textarea = screen.getByLabelText('Message the active provider');

    fireEvent.change(textarea, { target: { value: '#not' } });
    expect(await screen.findByRole('option', { name: 'notes.md · Greenhouse' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /stale/ })).toBeNull();

    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onAddKnowledgeRef).toHaveBeenCalledWith({
      documentId: 'd1',
      title: 'notes.md',
      collectionId: 'c1',
      collectionName: 'Greenhouse',
    });
    // The "#not" query is removed from the text.
    await waitFor(() => expect(textarea).toHaveValue(''));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('picking the same document twice is ignored', async () => {
    const { onAddKnowledgeRef } = renderDocPickerHarness({
      knowledgeRefs: [{ documentId: 'd1', title: 'notes.md', collectionId: 'c1', collectionName: 'Greenhouse' }],
    });
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: '#not' } });
    await screen.findByRole('option', { name: 'notes.md · Greenhouse' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onAddKnowledgeRef).not.toHaveBeenCalled();
  });

  it('Enter on a bare # the reader never navigated closes the picker and sends', async () => {
    const { onAddKnowledgeRef, onSend } = renderDocPickerHarness();
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: '#' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onAddKnowledgeRef).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onSend).toHaveBeenCalled();
  });

  it('a bare # still picks once the reader moves through the list', async () => {
    const { onAddKnowledgeRef } = renderDocPickerHarness();
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: '#' } });
    await screen.findByRole('option', { name: 'stale.md · Greenhouse' });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onAddKnowledgeRef).toHaveBeenCalledWith(expect.objectContaining({ documentId: 'd2' }));
  });

  it('with no matching document, Enter sends the text as typed ("#1 priority")', async () => {
    const { onAddKnowledgeRef, onSend } = renderDocPickerHarness();
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: '#1' } });
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeNull());
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onAddKnowledgeRef).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalled();
  });

  it('Shift+Enter inserts a line break instead of picking', async () => {
    const { onAddKnowledgeRef, onSend } = renderDocPickerHarness();
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: '#not' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(onAddKnowledgeRef).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('Escape closes the picker and leaves the text as typed', async () => {
    renderDocPickerHarness();
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: '#not' } });
    await screen.findByRole('listbox');
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(textarea).toHaveValue('#not');
  });

  it('never opens for a chat with no collections at all (criterion 13)', async () => {
    const { listKnowledgeDocuments } = await import('../ipc/client');
    renderDocPickerHarness({ collections: [] });
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: '#not' } });
    await Promise.resolve();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(listKnowledgeDocuments).not.toHaveBeenCalled();
  });

  it('does not open while an IME composition is in progress, and re-evaluates once it ends', async () => {
    renderDocPickerHarness();
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.compositionStart(textarea);
    fireEvent.change(textarea, { target: { value: '#not' } });
    await Promise.resolve();
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.compositionEnd(textarea);
    expect(await screen.findByRole('listbox')).toBeInTheDocument();
  });

  it('Enter during an IME composition does not send even with a query typed', () => {
    const { onSend } = renderDocPickerHarness();
    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true });
    expect(onSend).not.toHaveBeenCalled();
  });
});

describe('Composer native window drop (M1, D13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes addDroppedPaths that attaches the way an HTML5 drop would', async () => {
    const { saveDroppedAttachment } = await import('../ipc/client');
    const ref = createRef<ComposerHandle>();
    renderComposer({ ref });

    act(() => ref.current?.addDroppedPaths(['C:\\notes\\dropped.txt']));
    await waitFor(() => expect(saveDroppedAttachment).toHaveBeenCalledWith('conv-1', 'C:\\notes\\dropped.txt'));
    expect(await screen.findByText('dropped.txt')).toBeInTheDocument();
  });

  it('ignores a native drop within the dedup window of an HTML5 drop that already fired', async () => {
    const { saveAttachment, saveDroppedAttachment } = await import('../ipc/client');
    const ref = createRef<ComposerHandle>();
    renderComposer({ ref });

    const composerBox = document.querySelector('.composer') as HTMLElement;
    const file = new File(['hi'], 'from-html5.txt', { type: 'text/plain' });
    fireEvent.drop(composerBox, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(saveAttachment).toHaveBeenCalledTimes(1));

    act(() => ref.current?.addDroppedPaths(['C:\\notes\\dropped.txt']));
    expect(saveDroppedAttachment).not.toHaveBeenCalled();
  });

  it('ignores an HTML5 drop within the dedup window of a native drop that already fired', async () => {
    const { saveAttachment, saveDroppedAttachment } = await import('../ipc/client');
    const ref = createRef<ComposerHandle>();
    renderComposer({ ref });

    act(() => ref.current?.addDroppedPaths(['C:\\notes\\dropped.txt']));
    await waitFor(() => expect(saveDroppedAttachment).toHaveBeenCalledTimes(1));

    const composerBox = document.querySelector('.composer') as HTMLElement;
    const file = new File(['hi'], 'from-html5.txt', { type: 'text/plain' });
    fireEvent.drop(composerBox, { dataTransfer: { files: [file] } });
    expect(saveAttachment).not.toHaveBeenCalled();
  });

  it('does nothing without a conversation', () => {
    const ref = createRef<ComposerHandle>();
    renderComposer({ ref, conversationId: null });
    expect(() => ref.current?.addDroppedPaths(['C:\\notes\\dropped.txt'])).not.toThrow();
  });
});

describe('Composer Web and Research toggles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ready: AppSettings = {
    ...baseSettings,
    localOnly: false,
    webSearchEnabled: true,
    webSearchConsentAcknowledged: true,
  };
  const webToggle = () => screen.getByRole('button', { name: 'Web' });
  const researchToggle = () => screen.getByRole('button', { name: 'Research' });

  it('shows Web and Research beside "+", off, and drives the same handlers', () => {
    const onResearchToggle = vi.fn();
    const { onWebSearchToggle } = renderComposer({ settings: ready, onResearchToggle });
    expect(webToggle()).toHaveAttribute('aria-pressed', 'false');
    expect(webToggle()).toHaveAttribute('title', 'Web search off');
    expect(researchToggle()).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(webToggle());
    fireEvent.click(researchToggle());
    expect(onWebSearchToggle).toHaveBeenCalledTimes(1);
    expect(onResearchToggle).toHaveBeenCalledTimes(1);
  });

  it('reflects on as pressed, with no duplicate chip', () => {
    renderComposer({ settings: ready, webSearchOn: true, onResearchToggle: vi.fn(), researchOn: true });
    expect(webToggle()).toHaveAttribute('aria-pressed', 'true');
    expect(webToggle()).toHaveAttribute('title', 'Web search on (provider)');
    expect(researchToggle()).toHaveAttribute('aria-pressed', 'true');
    expect(researchToggle()).toHaveAttribute('title', 'Research is on: your next message starts a Research run');
    expect(screen.queryByRole('group', { name: 'Active in this chat' })).toBeNull();
  });

  it('leaves Research out when the host does not wire it', () => {
    renderComposer({ settings: ready });
    expect(screen.queryByRole('button', { name: 'Research' })).toBeNull();
    expect(webToggle()).toBeEnabled();
  });

  it.each([
    ['local-only is on', { ...ready, localOnly: true }, 'Web search is not available in local-only mode'],
    ['web search is off in Settings', { ...ready, webSearchEnabled: false }, 'Turn on web search in Settings to use it'],
  ])('disables Web, with the reason, when %s', (_name, settings, reason) => {
    renderComposer({ settings, webSearchOn: true });
    expect(webToggle()).toBeDisabled();
    // Unavailable means off, whatever the chat's flag says.
    expect(webToggle()).toHaveAttribute('aria-pressed', 'false');
    expect(webToggle()).toHaveAttribute('title', reason);
  });

  it.each([
    ['local-only is on', { ...ready, localOnly: true }, 'Research is not available in local-only mode'],
    ['web search is off', { ...ready, webSearchEnabled: false }, 'Turn on web search in Settings to use Research'],
    [
      'the web search notice is not accepted',
      { ...ready, webSearchConsentAcknowledged: false },
      'Turn on Web once to accept its notice, then use Research',
    ],
  ])('disables Research, with the reason, when %s', (_name, settings, reason) => {
    renderComposer({ settings, onResearchToggle: vi.fn() });
    expect(researchToggle()).toBeDisabled();
    expect(researchToggle()).toHaveAttribute('title', reason);
  });

  it('lets Research be turned off after settings made it unavailable', () => {
    const onResearchToggle = vi.fn();
    renderComposer({ settings: { ...ready, webSearchEnabled: false }, onResearchToggle, researchOn: true });
    expect(researchToggle()).toBeEnabled();
    fireEvent.click(researchToggle());
    expect(onResearchToggle).toHaveBeenCalledTimes(1);
  });

  it('locks both while a reply streams', () => {
    renderComposer({ settings: ready, onResearchToggle: vi.fn(), streaming: true });
    expect(webToggle()).toBeDisabled();
    expect(researchToggle()).toBeDisabled();
    expect(webToggle()).toHaveAttribute('title', 'Available when the reply finishes');
  });

  it("leaves both out of a draft's chat, whose Sources tab owns them", () => {
    renderComposer({
      settings: ready,
      onResearchToggle: vi.fn(),
      draftSources: { webSearch: true, documents: 0, reports: 0 },
    });
    expect(screen.queryByRole('button', { name: 'Web' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Research' })).toBeNull();
  });

  it('drops the labels to icons, named by aria-label, when the composer is narrow', () => {
    const original = globalThis.ResizeObserver;
    class NarrowObserver {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        this.callback(
          [{ target, contentRect: { width: 400 } } as unknown as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      disconnect() {}
      unobserve() {}
    }
    globalThis.ResizeObserver = NarrowObserver as unknown as typeof ResizeObserver;
    try {
      renderComposer({ settings: ready, onResearchToggle: vi.fn() });
      expect(webToggle()).toHaveAttribute('aria-label', 'Web');
      expect(webToggle()).toHaveAttribute('data-icon-only', 'true');
      expect(webToggle()).not.toHaveTextContent('Web');
      expect(researchToggle()).toHaveAttribute('aria-label', 'Research');
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});

describe('Composer starter chips', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const starters = () => screen.queryByRole('group', { name: 'Ways to start' });

  it('are hidden unless the chat is empty', () => {
    renderComposer({ onWorkspacePick: vi.fn(), onToggleSkill: vi.fn() });
    expect(starters()).toBeNull();
  });

  it('offer a folder, a file and a skill on an empty chat', () => {
    renderComposer({ showStarters: true, onWorkspacePick: vi.fn(), onToggleSkill: vi.fn() });
    const row = starters()!;
    const labels = Array.from(row.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Work in a folder', 'Ask about a file', 'Use a skill']);
  });

  it('"Work in a folder" opens the folder picker and focuses the textbox', () => {
    const onWorkspacePick = vi.fn();
    renderComposer({ showStarters: true, onWorkspacePick });
    fireEvent.click(screen.getByRole('button', { name: 'Work in a folder' }));
    expect(onWorkspacePick).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByLabelText('Message the active provider'));
  });

  it('"Ask about a file" opens the file picker', () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    renderComposer({ showStarters: true });
    fireEvent.click(screen.getByRole('button', { name: 'Ask about a file' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByLabelText('Message the active provider'));
    click.mockRestore();
  });

  it('"Use a skill" opens the skills popover', () => {
    renderComposer({ showStarters: true, onToggleSkill: vi.fn(), skills: [skill('s1', 'Review')] });
    fireEvent.click(screen.getByRole('button', { name: 'Use a skill' }));
    expect(screen.getByRole('dialog', { name: 'Skills for this chat' })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('Message the active provider'));
  });

  it('does not offer a folder that is already in use', () => {
    renderComposer({ showStarters: true, onWorkspacePick: vi.fn(), workspaceRoot: 'C:/work/garden' });
    expect(screen.queryByRole('button', { name: 'Work in a folder' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Ask about a file' })).toBeInTheDocument();
  });

  it('offers nothing while a reply streams', () => {
    renderComposer({ showStarters: true, streaming: true, onWorkspacePick: vi.fn(), onToggleSkill: vi.fn() });
    expect(starters()).toBeNull();
  });
});

/** The `/` tools menu needs the prompt fed back, like the `#` picker. */
function renderSlashHarness(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn();
  const onWebSearchToggle = vi.fn();

  function Harness() {
    const [prompt, setPrompt] = useState('');
    return (
      <Composer
        settings={{ ...baseSettings, localOnly: false, webSearchEnabled: true, webSearchConsentAcknowledged: true }}
        onSelectModel={vi.fn()}
        conversationId="conv-1"
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={onSend}
        onStop={vi.fn()}
        streaming={false}
        webSearchOn={false}
        onWebSearchToggle={onWebSearchToggle}
        {...overrides}
      />
    );
  }
  render(<Harness />);
  const textarea = screen.getByLabelText('Message the active provider') as HTMLTextAreaElement;
  const type = (value: string) => {
    textarea.focus();
    fireEvent.change(textarea, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  };
  return { onSend, onWebSearchToggle, textarea, type };
}

describe('Composer slash menu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const menu = () => screen.queryByRole('listbox', { name: 'Tools' });
  const optionNames = () => screen.getAllByRole('option').map((o) => o.querySelector('b')?.textContent);

  it('hints at it in the placeholder', () => {
    renderSlashHarness();
    expect(screen.getByPlaceholderText('Message… or type / for tools')).toBeInTheDocument();
  });

  it('opens on a leading / with every tool that can run', () => {
    const { type, textarea } = renderSlashHarness({
      onResearchToggle: vi.fn(),
      onWorkspacePick: vi.fn(),
      onToggleSkill: vi.fn(),
    });
    type('/');
    expect(menu()).toBeInTheDocument();
    expect(optionNames()).toEqual(['/web', '/research', '/folder', '/file', '/skill']);
    expect(textarea).toHaveAttribute('aria-controls', 'composer-slash-menu-list');
    expect(textarea).toHaveAttribute('aria-activedescendant', 'composer-slash-option-web');
  });

  it('leaves out tools that are unavailable', () => {
    const { type } = renderSlashHarness({ settings: baseSettings, onResearchToggle: vi.fn() });
    type('/');
    // Local-only: no web, no Research; no folder or skills wired.
    expect(optionNames()).toEqual(['/file']);
  });

  it('stays shut for a / that is not the first character', () => {
    const { type } = renderSlashHarness();
    type('and/or');
    expect(menu()).toBeNull();
  });

  it('filters as you type and closes when nothing matches', () => {
    const { type } = renderSlashHarness({ onResearchToggle: vi.fn(), onWorkspacePick: vi.fn() });
    type('/f');
    expect(optionNames()).toEqual(['/folder', '/file']);
    type('/usr');
    expect(menu()).toBeNull();
    type('/web now');
    expect(menu()).toBeNull();
  });

  it('runs the picked tool on Enter and removes the typed command', () => {
    const { type, textarea, onWebSearchToggle, onSend } = renderSlashHarness();
    type('/we');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onWebSearchToggle).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('');
    expect(menu()).toBeNull();
  });

  it('opens again for the next / after a pick', async () => {
    const { type, textarea, onWebSearchToggle } = renderSlashHarness();
    type('/');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(onWebSearchToggle).toHaveBeenCalledTimes(1);
    await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    type('/');
    expect(menu()).toBeInTheDocument();
  });

  it('moves with the arrows and picks with Tab', () => {
    const onWorkspacePick = vi.fn();
    const { type, textarea } = renderSlashHarness({ onResearchToggle: vi.fn(), onWorkspacePick });
    type('/');
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    fireEvent.keyDown(textarea, { key: 'ArrowDown' });
    expect(textarea).toHaveAttribute('aria-activedescendant', 'composer-slash-option-folder');
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    // Wraps from the top to the last option.
    expect(textarea).toHaveAttribute('aria-activedescendant', 'composer-slash-option-file');
    fireEvent.keyDown(textarea, { key: 'ArrowUp' });
    fireEvent.keyDown(textarea, { key: 'Tab' });
    expect(onWorkspacePick).toHaveBeenCalledTimes(1);
  });

  it('opens the skills popover from /skill', () => {
    const { type, textarea } = renderSlashHarness({ onToggleSkill: vi.fn() });
    type('/sk');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(screen.getByRole('dialog', { name: 'Skills for this chat' })).toBeInTheDocument();
  });

  it('picks with the mouse without leaving the textbox', () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    const { type, textarea } = renderSlashHarness();
    type('/');
    fireEvent.mouseDown(screen.getByRole('option', { name: /\/file/ }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe('');
    expect(document.activeElement).toBe(textarea);
    click.mockRestore();
  });

  it('closes on Escape with the text untouched, nothing run, and the key kept from the shell', () => {
    const { type, textarea, onWebSearchToggle } = renderSlashHarness();
    const shell = vi.fn();
    window.addEventListener('keydown', shell);
    document.addEventListener('keydown', shell, true);
    try {
      type('/we');
      fireEvent.keyDown(textarea, { key: 'Escape' });
      expect(menu()).toBeNull();
      expect(textarea.value).toBe('/we');
      expect(onWebSearchToggle).not.toHaveBeenCalled();
      expect(shell).not.toHaveBeenCalled();
      // Stays closed while the same word is edited...
      type('/web');
      expect(menu()).toBeNull();
      // ...and Enter then sends it as text.
    } finally {
      window.removeEventListener('keydown', shell);
      document.removeEventListener('keydown', shell, true);
    }
    // Once the / is gone it can open again.
    type('');
    type('/');
    expect(menu()).toBeInTheDocument();
  });
});

describe('Composer document attachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function attach(name: string, type: string) {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], name, { type })] } });
    await screen.findByText(name);
  }

  it('offers documents as well as images in the picker', () => {
    renderComposer();
    const accept = (document.querySelector('input[type="file"]') as HTMLInputElement).accept;
    for (const wanted of ['image/png', '.pdf', '.docx', '.txt', '.md', '.csv']) {
      expect(accept).toContain(wanted);
    }
  });

  it('says a text document is sent as text, and forwards it with the turn', async () => {
    const { attachmentDelivery } = await import('../ipc/client');
    vi.mocked(attachmentDelivery).mockResolvedValueOnce({ kind: 'text' });
    const { onSend } = renderComposer();
    await attach('notes.txt', 'text/plain');

    expect(await screen.findByText('Sent as text')).toBeInTheDocument();
    expect(attachmentDelivery).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4', 'att-1');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledWith([{ id: 'att-1', mimeType: 'text/plain', fileName: 'notes.txt' }]);
  });

  it('says a PDF is sent as PDF when the model takes it natively', async () => {
    const { attachmentDelivery } = await import('../ipc/client');
    vi.mocked(attachmentDelivery).mockResolvedValueOnce({ kind: 'pdf_native' });
    renderComposer();
    await attach('report.pdf', 'application/pdf');
    expect(await screen.findByText('Sent as PDF')).toBeInTheDocument();
  });

  it('says why an unsupported file is not sent and forwards nothing for it', async () => {
    const { attachmentDelivery } = await import('../ipc/client');
    vi.mocked(attachmentDelivery).mockResolvedValueOnce({ kind: 'unsupported', reason: 'xlsx files' });
    const { onSend } = renderComposer({ prompt: 'hello' });
    await attach('sheet.xlsx', 'application/octet-stream');

    expect(await screen.findByText("Not sent: xlsx files aren't supported yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledWith(undefined);
  });

  it('asks again when the active model changes', async () => {
    const { attachmentDelivery } = await import('../ipc/client');
    vi.mocked(attachmentDelivery)
      .mockResolvedValueOnce({ kind: 'text' })
      .mockResolvedValueOnce({ kind: 'pdf_native' });
    const props = {
      onSelectModel: vi.fn(),
      conversationId: 'conv-1',
      prompt: '',
      onPromptChange: vi.fn(),
      onSend: vi.fn(),
      onStop: vi.fn(),
      streaming: false,
      webSearchOn: false,
      onWebSearchToggle: vi.fn(),
    };
    const { rerender } = render(<Composer settings={baseSettings} {...props} />);
    await attach('report.pdf', 'application/pdf');
    expect(await screen.findByText('Sent as text')).toBeInTheDocument();

    rerender(<Composer settings={{ ...baseSettings, activeModel: 'claude-opus-4' }} {...props} />);
    expect(await screen.findByText('Sent as PDF')).toBeInTheDocument();
    expect(attachmentDelivery).toHaveBeenLastCalledWith('anthropic', 'claude-opus-4', 'att-1');
  });

  it('still lets an image through when the delivery query fails', async () => {
    const { attachmentDelivery, saveAttachment } = await import('../ipc/client');
    vi.mocked(attachmentDelivery).mockRejectedValueOnce(new Error('no command'));
    vi.mocked(saveAttachment).mockResolvedValueOnce({
      id: 'att-img',
      conversationId: 'conv-1',
      path: 'ab/img',
      mimeType: 'image/png',
      sizeBytes: 5,
      retentionState: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      origin: 'pic.png',
    });
    const { onSend } = renderComposer();
    await attach('pic.png', 'image/png');
    expect(await screen.findByText('Ready')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledWith([{ id: 'att-img', mimeType: 'image/png', fileName: 'pic.png' }]);
  });

  it('lights up the composer while the shell says a hovering file will attach', () => {
    renderComposer({ attachDropActive: true });
    expect(document.querySelector('.composer')).toHaveClass('drop-active');
  });
});
