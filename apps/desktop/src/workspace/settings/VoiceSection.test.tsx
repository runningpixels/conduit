import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';

const ipc = vi.hoisted(() => ({
  dictationStatus: vi.fn(),
  saveProviderCredential: vi.fn(),
  updateSettings: vi.fn(),
  openExternalUrl: vi.fn(),
  loadProviderCredentialReference: vi.fn(),
}));
vi.mock('../../ipc/client', () => ipc);

import { VoiceSection } from './VoiceSection';

const options = [
  { id: 'openai', name: 'OpenAI', hasKey: false, model: 'gpt-4o-mini-transcribe' },
  { id: 'openrouter', name: 'OpenRouter', hasKey: true, model: 'openai/gpt-4o-mini-transcribe' },
  { id: 'groq', name: 'Groq', hasKey: false, model: 'whisper-large-v3-turbo' },
];

const automatic = {
  provider: 'openrouter',
  providerName: 'OpenRouter',
  blocked: null,
  maxSeconds: 300,
  chosen: null,
  options,
};

const base = {
  activeProvider: 'anthropic',
  localOnly: false,
  dictationProvider: null,
} as unknown as AppSettings;

describe('VoiceSection', () => {
  beforeEach(() => {
    ipc.dictationStatus.mockResolvedValue(automatic);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('starts on Automatic and says where the voice goes', async () => {
    render(<VoiceSection settings={base} onSettingsChange={vi.fn()} onStatus={vi.fn()} />);
    expect(await screen.findByText('Your voice is sent to OpenRouter (openai/gpt-4o-mini-transcribe).')).toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: 'Dictation provider' });
    expect(select).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Groq (no key yet)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'OpenRouter' })).toBeInTheDocument();
  });

  it('choosing a provider without a key saves the choice and asks for its key', async () => {
    const onSettingsChange = vi.fn();
    const chosen = { ...base, dictationProvider: 'groq' } as AppSettings;
    ipc.updateSettings.mockResolvedValue(chosen);
    const { rerender } = render(<VoiceSection settings={base} onSettingsChange={onSettingsChange} onStatus={vi.fn()} />);
    const select = await screen.findByRole('combobox', { name: 'Dictation provider' });

    ipc.dictationStatus.mockResolvedValue({ ...automatic, provider: null, providerName: null, blocked: 'noKey', chosen: 'groq' });
    await act(async () => {
      fireEvent.change(select, { target: { value: 'groq' } });
    });
    expect(ipc.updateSettings).toHaveBeenCalledWith({ dictationProvider: 'groq' });
    expect(onSettingsChange).toHaveBeenCalledWith(chosen);

    rerender(<VoiceSection settings={chosen} onSettingsChange={onSettingsChange} onStatus={vi.fn()} />);
    expect(await screen.findByText('Groq needs an API key before dictation can use it.')).toBeInTheDocument();
    expect(screen.getByText('Saving a key here doesn’t change your chat provider.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Get a Groq key/ })).toBeInTheDocument();
  });

  it('saves the key for the chosen provider only, then reports it ready', async () => {
    const onStatus = vi.fn();
    const chosen = { ...base, dictationProvider: 'groq' } as AppSettings;
    ipc.dictationStatus.mockResolvedValue({ ...automatic, provider: null, providerName: null, blocked: 'noKey', chosen: 'groq' });
    ipc.saveProviderCredential.mockResolvedValue({ credentialRef: 'groq', storedInKeychain: true });
    render(<VoiceSection settings={chosen} onSettingsChange={vi.fn()} onStatus={onStatus} />);
    const input = await screen.findByLabelText('Groq API key');
    fireEvent.change(input, { target: { value: 'gsk_test' } });

    ipc.dictationStatus.mockResolvedValue({
      ...automatic,
      provider: 'groq',
      providerName: 'Groq',
      chosen: 'groq',
      options: options.map((o) => (o.id === 'groq' ? { ...o, hasKey: true } : o)),
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    });
    expect(ipc.saveProviderCredential).toHaveBeenCalledWith({ providerId: 'groq', secret: 'gsk_test' });
    expect(ipc.updateSettings).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith('Groq key saved. Dictation is ready.');
    expect(await screen.findByText('Your voice is sent to Groq (whisper-large-v3-turbo).')).toBeInTheDocument();
    expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument();
  });

  it('going back to Automatic clears the choice', async () => {
    const chosen = { ...base, dictationProvider: 'openrouter' } as AppSettings;
    ipc.updateSettings.mockResolvedValue(base);
    render(<VoiceSection settings={chosen} onSettingsChange={vi.fn()} onStatus={vi.fn()} />);
    const select = await screen.findByRole('combobox', { name: 'Dictation provider' });
    await waitFor(() => expect(select).toHaveValue('openrouter'));
    await act(async () => {
      fireEvent.change(select, { target: { value: '' } });
    });
    expect(ipc.updateSettings).toHaveBeenCalledWith({ dictationProvider: null });
  });

  it('says dictation is off in local-only mode and offers no key field', async () => {
    const local = { ...base, localOnly: true, dictationProvider: 'groq' } as AppSettings;
    ipc.dictationStatus.mockResolvedValue({ ...automatic, provider: null, providerName: null, blocked: 'localOnly', chosen: 'groq' });
    render(<VoiceSection settings={local} onSettingsChange={vi.fn()} onStatus={vi.fn()} />);
    expect(await screen.findByText(/Local-only mode is on, so dictation is off/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Groq API key')).not.toBeInTheDocument();
  });
});
