/**
 * The picker's own contract, separate from the composer that hosts it: the
 * imperative handle the status line summons it through, the disabled state
 * while streaming, and the fan-out's failure behaviour.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
    expect(screen.queryByRole('menu')).toBeNull();
    ref.current?.open();
    expect(await screen.findByRole('menu')).toBeInTheDocument();
  });

  it('stays shut through the handle while disabled', () => {
    const { ref } = renderPicker({ disabled: true });
    ref.current?.open();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('labels a no-key provider by its posture, not a price', async () => {
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByText('Ollama · no key needed')).toBeInTheDocument();
    // qwen3:14b has no bundled price, so the tail reports what it is instead.
    expect(screen.getByRole('menuitem', { name: /qwen3:14b/ })).toHaveTextContent('local');
  });

  it('passes the descriptor default base url so an unconfigured provider is seeded', async () => {
    const { onSelectModel } = renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /qwen3:14b/ }));
    expect(onSelectModel).toHaveBeenCalledWith('ollama', 'qwen3:14b', 'http://localhost:11434');
  });

  it('closes on Escape', async () => {
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
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
    await screen.findByRole('menu');
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByTitle('Switch model'));
    await screen.findByRole('menu');
    expect(listProviderDescriptors).toHaveBeenCalledTimes(1);
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
    // …and the hung one still appears, degraded to the typing affordance rather
    // than vanishing. A provider you cannot see is a provider you cannot pick.
    expect(screen.getByText('Ollama · no key needed')).toBeInTheDocument();
    expect(screen.getByLabelText('Model id for Ollama')).toBeInTheDocument();
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
  beforeEach(async () => {
    const { listProviderModels } = await mocks();
    vi.mocked(listProviderModels).mockImplementation(async (id: string) =>
      id === 'anthropic'
        ? ([{ id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' }] as never)
        : ([] as never),
    );
  });

  it('still renders the provider, so it stays selectable', async () => {
    renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));
    expect(await screen.findByText('Ollama · no key needed')).toBeInTheDocument();
  });

  it('accepts a typed model id and writes it with its provider', async () => {
    const { onSelectModel } = renderPicker();
    fireEvent.click(screen.getByTitle('Switch model'));

    const input = await screen.findByLabelText('Model id for Ollama');
    fireEvent.change(input, { target: { value: 'qwen3:32b' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSelectModel).toHaveBeenCalledWith('ollama', 'qwen3:32b', 'http://localhost:11434');
  });

  it('ignores an empty id rather than writing a blank model', async () => {
    const { onSelectModel } = renderPicker();
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
