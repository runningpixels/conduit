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
  listProviderModels: vi.fn().mockResolvedValue([
    { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' },
    { id: 'claude-opus-4', displayName: 'Claude Opus 4' },
  ]),
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
  const onSettingsChange = vi.fn();
  const onWebSearchToggle = vi.fn();

  render(
    <Composer
      settings={baseSettings}
      onSettingsChange={onSettingsChange}
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

  return { onSend, onStop, onPromptChange, onSettingsChange, onWebSearchToggle };
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

  it('opens the model switcher and persists a new model selection', async () => {
    const { updateSettings } = await import('../ipc/client');
    const { onSettingsChange } = renderComposer();

    fireEvent.click(screen.getByTitle('Switch model'));

    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(2));
    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[1], { target: { value: 'claude-opus-4' } });

    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({ activeModel: 'claude-opus-4' }),
    );
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
