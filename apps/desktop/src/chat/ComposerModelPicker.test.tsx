/**
 * The picker's own contract, separate from the composer that hosts it: the
 * imperative handle the status line summons it through, the disabled state
 * while streaming, and the fan-out's failure behaviour.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import type { AppSettings } from '@conduit/config-schema';
import { ComposerModelPicker, type ComposerModelPickerHandle } from './ComposerModelPicker';

const settings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  providerEndpoints: {},
} as unknown as AppSettings;

const DESCRIPTORS = [
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
    id: 'ollama',
    displayName: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434',
    credentialMode: 'none',
    isLocal: true,
    showBaseUrlField: true,
    tier: 1,
    description: null,
  },
];

vi.mock('../ipc/client', () => ({
  listProviderDescriptors: vi.fn(),
  listProviderModels: vi.fn(),
  // Every provider has a key unless a test says otherwise.
  loadProviderCredentialReference: vi.fn(async (providerId: string) => ({
    providerId,
    credentialRef: '',
    storedInKeychain: true,
  })),
  // The backend's price resolution, reduced to the one model these tests price.
  resolveModelPrices: vi.fn(async (_provider: string, modelIds: string[]) =>
    modelIds.map((id) =>
      id === 'claude-sonnet-4'
        ? { price: { inputPerMtok: 3, outputPerMtok: 15 }, source: 'snapshot' }
        : null,
    ),
  ),
}));

async function mocks() {
  return await import('../ipc/client');
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { listProviderDescriptors, listProviderModels } = await mocks();
  vi.mocked(listProviderDescriptors).mockResolvedValue(DESCRIPTORS as never);
  vi.mocked(listProviderModels).mockImplementation(async (id: string) =>
    id === 'anthropic'
      ? ([{ id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' }] as never)
      : ([{ id: 'qwen3:14b', displayName: 'qwen3:14b' }] as never),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

function renderPicker(overrides: { disabled?: boolean } = {}) {
  const onSelectModel = vi.fn();
  const ref = createRef<ComposerModelPickerHandle>();
  render(
    <ComposerModelPicker
      ref={ref}
      settings={settings}
      onSelectModel={onSelectModel}
      disabled={overrides.disabled}
    />,
  );
  return { onSelectModel, ref };
}

describe('ComposerModelPicker', () => {
  it('shows the active model on the trigger', () => {
    renderPicker();
    expect(screen.getByTitle('Switch model')).toHaveTextContent('claude-sonnet-4');
  });

  it('opens through the imperative handle, which the status line uses', async () => {
    const { ref } = renderPicker();
    expect(screen.queryByRole('dialog')).toBeNull();
    ref.current?.open();
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('stays shut through the handle while disabled', () => {
    const { ref } = renderPicker({ disabled: true });
    ref.current?.open();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('labels a no-key provider by its posture, not a price', async () => {
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByText('Ollama · no key needed')).toBeInTheDocument();
    // qwen3:14b has no bundled price, so the tail reports what it is instead.
    expect(screen.getByRole('option', { name: /qwen3:14b/ })).toHaveTextContent('local');
  });

  it('does not call a cloud preset self-hosted because it has a default base url', async () => {
    const { listProviderDescriptors, listProviderModels } = await mocks();
    vi.mocked(listProviderDescriptors).mockResolvedValue([
      ...DESCRIPTORS,
      {
        id: 'xai',
        displayName: 'xAI',
        defaultBaseUrl: 'https://api.x.ai/v1',
        credentialMode: 'required',
        isLocal: false,
        showBaseUrlField: true,
        tier: 2,
        description: 'Grok models',
      },
    ] as never);
    vi.mocked(listProviderModels).mockImplementation(async (id: string) =>
      id === 'xai' ? ([{ id: 'grok-unpriced', displayName: 'grok-unpriced' }] as never) : ([] as never),
    );
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    const row = await screen.findByRole('option', { name: /grok-unpriced/ });
    expect(row).not.toHaveTextContent(/self-?hosted|local/i);
  });

  it('passes the descriptor default base url so an unconfigured provider is seeded', async () => {
    const { onSelectModel } = renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    fireEvent.click(await screen.findByRole('option', { name: /qwen3:14b/ }));
    expect(onSelectModel).toHaveBeenCalledWith('ollama', 'qwen3:14b', 'http://localhost:11434');
  });

  it('closes on Escape', async () => {
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('fetches the catalogue on open, not on mount', async () => {
    const { listProviderDescriptors } = await mocks();
    renderPicker();
    expect(listProviderDescriptors).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTitle('Switch model'));
    await waitFor(() => expect(listProviderDescriptors).toHaveBeenCalledTimes(1));
  });

  it('caches the catalogue for the session across reopens', async () => {
    const { listProviderDescriptors } = await mocks();
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTitle('Switch model'));
    await screen.findByRole('dialog');
    expect(listProviderDescriptors).toHaveBeenCalledTimes(1);
  });

  it('shares the catalogue between pickers: a second one lists nothing again', async () => {
    const { listProviderDescriptors, listProviderModels } = await mocks();
    const first = render(<ComposerModelPicker settings={settings} onSelectModel={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Switch model'));
    await screen.findByText('Claude Sonnet 4');
    first.unmount();
    // A new chat's composer, say: it opens straight onto the cached rows.
    render(<ComposerModelPicker settings={settings} onSelectModel={vi.fn()} />);
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByText('Claude Sonnet 4')).toBeInTheDocument();
    expect(listProviderDescriptors).toHaveBeenCalledTimes(1);
    expect(listProviderModels).toHaveBeenCalledTimes(2);
  });

  it('draws each group as it answers, with a loading line for the rest', async () => {
    const { listProviderModels } = await mocks();
    vi.mocked(listProviderModels).mockImplementation((id: string) =>
      id === 'ollama'
        ? (Promise.resolve([{ id: 'qwen3:14b', displayName: 'qwen3:14b' }]) as never)
        : (new Promise(() => {}) as never),
    );
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByText('qwen3:14b')).toBeInTheDocument();
    expect(screen.getByText('Anthropic · keychain')).toBeInTheDocument();
    expect(screen.getByText('Loading models…')).toBeInTheDocument();
  });

  it('narrows to one provider from the side list, and back to all', async () => {
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    await screen.findByText('Claude Sonnet 4');
    await screen.findByText('qwen3:14b');
    const providers = screen.getByRole('group', { name: 'Show models from' });
    fireEvent.click(within(providers).getByRole('button', { name: /Ollama/ }));
    expect(screen.queryByText('Claude Sonnet 4')).toBeNull();
    expect(screen.getByRole('option', { name: /qwen3:14b/ })).toBeInTheDocument();
    fireEvent.click(within(providers).getByRole('button', { name: 'All providers' }));
    expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
  });

  it('sorts by price across providers, unpriced models last', async () => {
    const { resolveModelPrices, listProviderModels } = await mocks();
    vi.mocked(listProviderModels).mockImplementation(async (id: string) =>
      id === 'anthropic'
        ? ([
            { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' },
            { id: 'claude-haiku-4', displayName: 'Claude Haiku 4' },
          ] as never)
        : ([{ id: 'qwen3:14b', displayName: 'qwen3:14b' }] as never),
    );
    vi.mocked(resolveModelPrices).mockImplementation(async (_provider: string, ids: string[]) =>
      ids.map((id) =>
        id === 'claude-sonnet-4'
          ? { price: { inputPerMtok: 3, outputPerMtok: 15 }, source: 'snapshot' }
          : id === 'claude-haiku-4'
            ? { price: { inputPerMtok: 1, outputPerMtok: 5 }, source: 'snapshot' }
            : null,
      ) as never,
    );
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    await screen.findByText('qwen3:14b');
    await waitFor(() => expect(screen.getByRole('option', { name: /Claude Haiku 4/ })).toHaveTextContent('$1$5'));
    const names = () => screen.getAllByRole('option').map((row) => row.querySelector('.model-row-name')!.textContent);

    expect(screen.getByRole('button', { name: 'Sort by name, A to Z' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Sort by price, lowest first' }));
    expect(names()).toEqual(['Claude Haiku 4', 'Claude Sonnet 4', 'qwen3:14b']);
    // Out from under its caption, a row names its provider.
    expect(screen.getByRole('option', { name: /Claude Haiku 4/ })).toHaveTextContent('Anthropic · claude-haiku-4');

    // A second click on the active key flips it.
    fireEvent.click(screen.getByRole('button', { name: 'Sort by price, lowest first' }));
    expect(names()).toEqual(['Claude Sonnet 4', 'Claude Haiku 4', 'qwen3:14b']);
    expect(screen.getByRole('button', { name: 'Sort by price, highest first' })).toHaveAttribute('aria-pressed', 'true');

    // Name, flipped: Z to A within each provider.
    fireEvent.click(screen.getByRole('button', { name: 'Sort by name, A to Z' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sort by name, A to Z' }));
    expect(names()).toEqual(['Claude Sonnet 4', 'Claude Haiku 4', 'qwen3:14b']);
    expect(screen.getByRole('button', { name: 'Sort by name, Z to A' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('lists every provider again on Refresh', async () => {
    const { listProviderDescriptors, listProviderModels } = await mocks();
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    await screen.findByText('Claude Sonnet 4');
    vi.mocked(listProviderModels).mockImplementation(async (id: string) =>
      id === 'anthropic'
        ? ([{ id: 'claude-opus-5', displayName: 'Claude Opus 5' }] as never)
        : ([] as never),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh list' }));
    expect(await screen.findByText('Claude Opus 5')).toBeInTheDocument();
    expect(screen.queryByText('Claude Sonnet 4')).toBeNull();
    expect(listProviderDescriptors).toHaveBeenCalledTimes(2);
  });

  it('leaves out a provider with no key, and a local server that lists nothing', async () => {
    const { listProviderDescriptors, listProviderModels, loadProviderCredentialReference } = await mocks();
    vi.mocked(listProviderDescriptors).mockResolvedValue([
      ...DESCRIPTORS,
      { ...DESCRIPTORS[0], id: 'groq', displayName: 'Groq', tier: 0 },
      { ...DESCRIPTORS[0], id: 'openrouter', displayName: 'OpenRouter', tier: 0 },
    ] as never);
    vi.mocked(loadProviderCredentialReference).mockImplementation(async (providerId: string) => ({
      providerId,
      credentialRef: '',
      storedInKeychain: providerId === 'openrouter',
    }));
    vi.mocked(listProviderModels).mockImplementation(async (id: string) =>
      id === 'openrouter'
        ? ([{ id: 'z-ai/glm-5.3-flash', displayName: 'GLM 5.3 Flash' }] as never)
        : id === 'anthropic'
          ? ([{ id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' }] as never)
          : ([] as never), // Ollama: not running
    );
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByText('GLM 5.3 Flash')).toBeInTheDocument();
    // Anthropic has no key but is the provider in use, so it stays.
    expect(await screen.findByText('Claude Sonnet 4')).toBeInTheDocument();
    expect(screen.queryByText(/^Groq/)).toBeNull();
    expect(screen.queryByText(/^Ollama/)).toBeNull();
    // A provider without a key is never asked for its models.
    expect(listProviderModels).not.toHaveBeenCalledWith('groq');
  });

  /**
   * Risk R6. A provider that never answers must cost its own group and nothing
   * else — the menu is unusable if one stopped Ollama holds every other row
   * behind it.
   */
  it('renders the reachable groups when one provider hangs past the timeout', async () => {
    const { listProviderModels } = await mocks();
    vi.mocked(listProviderModels).mockImplementation((id: string) =>
      id === 'anthropic'
        ? (Promise.resolve([
            { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' },
          ]) as never)
        : (new Promise(() => {}) as never), // never settles
    );

    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));

    await vi.advanceTimersByTimeAsync(3000);

    // The reachable provider's rows are there…
    expect(await screen.findByText('Anthropic · keychain')).toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
    // …and the hung local server, which listed nothing and is not the one in
    // use, stays out of the menu rather than showing an empty group.
    expect(screen.queryByText('Ollama · no key needed')).toBeNull();
  });
});

/**
 * An aggregator lists hundreds of models in its own order; scanning that by
 * eye was the whole selection experience. These pin the order and the search.
 */
describe('ComposerModelPicker — ordering and search', () => {
  beforeEach(async () => {
    const { listProviderModels } = await mocks();
    vi.mocked(listProviderModels).mockImplementation(async (id: string) =>
      id === 'anthropic'
        ? ([
            { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' },
            { id: 'claude-haiku-4', displayName: 'Claude Haiku 4' },
            { id: 'claude-opus-4', displayName: 'Claude Opus 4' },
          ] as never)
        : ([
            { id: 'qwen3:14b', displayName: 'qwen3:14b' },
            { id: 'llama3.3:70b', displayName: 'llama3.3:70b' },
            { id: 'qwen3:8b', displayName: 'qwen3:8b' },
          ] as never),
    );
  });

  async function openPicker() {
    const result = renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    await screen.findByText('Claude Opus 4');
    return { ...result, search: screen.getByLabelText('Search models') };
  }

  const rowNames = () => screen.getAllByRole('option').map((row) => row.textContent);

  it('lists each group alphabetically, whatever order the provider returned', async () => {
    await openPicker();
    expect(rowNames()).toEqual([
      expect.stringMatching(/^Claude Haiku 4/),
      expect.stringMatching(/^Claude Opus 4/),
      expect.stringMatching(/^Claude Sonnet 4/),
      expect.stringMatching(/^llama3\.3:70b/),
      expect.stringMatching(/^qwen3:8b/),
      expect.stringMatching(/^qwen3:14b/),
    ]);
  });

  it('focuses the search on open so typing narrows straight away', async () => {
    const { search } = await openPicker();
    expect(search).toHaveFocus();
  });

  it('narrows every group to the rows that match, hiding empty groups', async () => {
    const { search } = await openPicker();
    fireEvent.change(search, { target: { value: 'qwen' } });
    expect(rowNames()).toEqual([expect.stringMatching(/^qwen3:8b/), expect.stringMatching(/^qwen3:14b/)]);
    expect(screen.queryByText('Anthropic · keychain')).toBeNull();
  });

  it('matches the provider name as well as the model', async () => {
    const { search } = await openPicker();
    fireEvent.change(search, { target: { value: 'ollama 14' } });
    expect(rowNames()).toEqual([expect.stringMatching(/^qwen3:14b/)]);
  });

  it('does not match a model family inside a provider name', async () => {
    const { search } = await openPicker();
    // "llama" is inside "Ollama" — only the llama model may match.
    fireEvent.change(search, { target: { value: 'llama' } });
    expect(rowNames()).toEqual([expect.stringMatching(/^llama3\.3:70b/)]);
  });

  it('takes the first match on Enter', async () => {
    const { search, onSelectModel } = await openPicker();
    fireEvent.change(search, { target: { value: 'opus' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelectModel).toHaveBeenCalledWith('anthropic', 'claude-opus-4', null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('steps from the search into the list on ArrowDown', async () => {
    const { search } = await openPicker();
    fireEvent.change(search, { target: { value: 'sonnet' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Claude Sonnet 4/ })).toHaveFocus();
  });

  it('says so when nothing matches', async () => {
    const { search } = await openPicker();
    fireEvent.change(search, { target: { value: 'gemini' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText('No models match “gemini”')).toBeInTheDocument();
  });

  it('clears a search on Escape before closing the dialog', async () => {
    const { search } = await openPicker();
    fireEvent.change(search, { target: { value: 'opus' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('starts each opening from the whole catalogue', async () => {
    const { search } = await openPicker();
    fireEvent.change(search, { target: { value: 'opus' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByLabelText('Search models')).toHaveValue('');
    expect(screen.getAllByRole('option')).toHaveLength(6);
  });
});

/**
 * V7's popover degraded to a free-text `Model id` input whenever a provider
 * returned no models, and its provider `<select>` listed every configured
 * provider regardless of whether one answered. A menu built only from returned
 * models silently drops both — and for a self-hosted endpoint with no
 * model-listing route that is the difference between awkward and unreachable.
 * These pin the relocation.
 */
describe('ComposerModelPicker — providers that list no models', () => {
  // A provider that lists nothing shows only while it is the one in use (a
  // self-hosted endpoint with no listing route): there its typing row is how
  // you name a model.
  const renderOllamaCurrent = () => {
    const onSelectModel = vi.fn();
    render(
      <ComposerModelPicker
        settings={{ ...settings, activeProvider: 'ollama', activeModel: '' } as AppSettings}
        onSelectModel={onSelectModel}
      />,
    );
    return { onSelectModel };
  };

  beforeEach(async () => {
    const { listProviderModels } = await mocks();
    vi.mocked(listProviderModels).mockImplementation(async (id: string) =>
      id === 'anthropic'
        ? ([{ id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' }] as never)
        : ([] as never),
    );
  });

  it('still renders the provider in use, so it stays selectable', async () => {
    renderOllamaCurrent();
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByText('Ollama · no key needed')).toBeInTheDocument();
  });

  it('leaves out one that lists nothing and is not in use', async () => {
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByText('Claude Sonnet 4')).toBeInTheDocument();
    expect(screen.queryByText('Ollama · no key needed')).toBeNull();
  });

  it('keeps the typing row reachable by searching the provider name', async () => {
    renderOllamaCurrent();
    fireEvent.click(screen.getByTitle('Switch model'));
    const search = await screen.findByLabelText('Search models');
    await screen.findByLabelText('Model id for Ollama');
    fireEvent.change(search, { target: { value: 'claude' } });
    expect(screen.queryByLabelText('Model id for Ollama')).toBeNull();
    fireEvent.change(search, { target: { value: 'olla' } });
    expect(screen.getByLabelText('Model id for Ollama')).toBeInTheDocument();
  });

  it('accepts a typed model id and writes it with its provider', async () => {
    const { onSelectModel } = renderOllamaCurrent();
    fireEvent.click(screen.getByTitle('Switch model'));

    const input = await screen.findByLabelText('Model id for Ollama');
    fireEvent.change(input, { target: { value: 'qwen3:32b' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectModel).toHaveBeenCalledWith('ollama', 'qwen3:32b', 'http://localhost:11434');
  });

  it('ignores an empty id rather than writing a blank model', async () => {
    const { onSelectModel } = renderOllamaCurrent();
    fireEvent.click(screen.getByTitle('Switch model'));

    const input = await screen.findByLabelText('Model id for Ollama');
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it('seeds the field with the active model when that provider is current', async () => {
    const onSelectModel = vi.fn();
    render(
      <ComposerModelPicker
        settings={{ ...settings, activeProvider: 'ollama', activeModel: 'qwen3:14b' } as AppSettings}
        onSelectModel={onSelectModel}
      />,
    );
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByLabelText('Model id for Ollama')).toHaveValue('qwen3:14b');
  });
});
