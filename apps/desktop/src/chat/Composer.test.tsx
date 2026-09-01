import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createRef } from 'react';
import type { ComponentProps } from 'react';
import type { AppSettings } from '@conduit/config-schema';
import { Composer, type ComposerHandle } from './Composer';
import { COMPOSER_MAX_HEIGHT_PX } from './composerTypes';

const baseSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  onboardingCompleted: true,
  webSearchEnabled: false,
  webSearch: {
    mode: 'auto' as const,
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
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
}));

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
    expect(active).toHaveTextContent('$3 / $15');
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

  it('exposes focusPrompt via ref', () => {
    const ref = createRef<ComposerHandle>();
    renderComposer({ ref });
    const textarea = screen.getByLabelText('Message the active provider');
    expect(document.activeElement).not.toBe(textarea);
    ref.current?.focusPrompt();
    expect(document.activeElement).toBe(textarea);
  });
});
