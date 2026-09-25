import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { AppSettings, ModelInfo } from '../../ipc/contracts';
import { ProviderPicker } from './ProviderPicker';

const MODELS: Record<string, ModelInfo[]> = {
  openrouter: [
    { id: 'aaa/first-listed', displayName: 'First listed' } as ModelInfo,
    { id: 'z-ai/glm-5.3-flash', displayName: 'Z.ai: GLM 5.3 Flash' } as ModelInfo,
  ],
  lmstudio: [{ id: 'qwen3-8b', displayName: 'qwen3-8b' } as ModelInfo],
  ollama: [],
};

vi.mock('../../ipc/client', () => ({
  listProviderDescriptors: vi.fn().mockResolvedValue([]),
  listProviderModels: vi.fn(async (providerId: string) => {
    if (providerId === 'groq') throw new Error('offline');
    return MODELS[providerId] ?? [];
  }),
  loadProviderCredentialReference: vi.fn().mockResolvedValue(null),
  saveProviderCredential: vi.fn(),
  updateSettings: vi.fn(),
  validateProviderCredentials: vi.fn(),
}));

/** Only the fields the picker reads. */
const START = {
  activeProvider: 'openrouter',
  activeModel: 'z-ai/glm-5.3-flash',
  localOnly: false,
  providerEndpoints: {},
} as unknown as AppSettings;

let latest: AppSettings = START;

function Harness({ initial = START }: { initial?: AppSettings }) {
  const [settings, setSettings] = useState(initial);
  latest = settings;
  return (
    <ProviderPicker
      settings={settings}
      onSettingsChange={(next) => {
        latest = next;
        setSettings(next);
      }}
      onStatus={() => {}}
    />
  );
}

function providerSelect(): HTMLSelectElement {
  return screen.getAllByRole('combobox')[0] as HTMLSelectElement;
}

describe('ProviderPicker model on provider switch', () => {
  beforeEach(() => {
    latest = START;
    localStorage.clear();
  });

  // Live: LM Studio picked after OpenRouter kept `z-ai/glm-5.3-flash`, so the
  // composer chip and every request named a model LM Studio does not have.
  it('replaces a model the new provider does not list with its first one', async () => {
    render(<Harness />);
    fireEvent.change(providerSelect(), { target: { value: 'lmstudio' } });
    await waitFor(() => expect(latest.activeModel).toBe('qwen3-8b'));
    expect(latest.activeProvider).toBe('lmstudio');
  });

  it('asks for a model when the new provider lists none', async () => {
    render(<Harness />);
    fireEvent.change(providerSelect(), { target: { value: 'ollama' } });
    await waitFor(() => expect(latest.activeProvider).toBe('ollama'));
    await waitFor(() => expect(latest.activeModel).toBe(''));
  });

  it('leaves the model alone when the listing fails', async () => {
    render(<Harness />);
    fireEvent.change(providerSelect(), { target: { value: 'groq' } });
    await waitFor(() => expect(latest.activeProvider).toBe('groq'));
    // Give the failed listing time to settle; nothing may be rewritten.
    await new Promise((r) => setTimeout(r, 20));
    expect(latest.activeModel).toBe('z-ai/glm-5.3-flash');
  });

  it('never rewrites a saved model on mount', async () => {
    // A hand-typed id the listing omits is a choice, not a leftover.
    const typed = { ...START, activeProvider: 'lmstudio', activeModel: 'my-custom-model' } as AppSettings;
    render(<Harness initial={typed} />);
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBeGreaterThan(1));
    expect(latest.activeModel).toBe('my-custom-model');
  });

  it('restores the model a provider had when switched back to', async () => {
    // Without this, returning to OpenRouter took the first of its hundreds of
    // listed models instead of the one the user had been using there.
    render(<Harness />);
    fireEvent.change(providerSelect(), { target: { value: 'lmstudio' } });
    await waitFor(() => expect(latest.activeModel).toBe('qwen3-8b'));
    fireEvent.change(providerSelect(), { target: { value: 'openrouter' } });
    await waitFor(() => expect(latest.activeProvider).toBe('openrouter'));
    await waitFor(() => expect(latest.activeModel).toBe('z-ai/glm-5.3-flash'));
  });
});
