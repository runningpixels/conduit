import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';
import { UsageSection } from './UsageSection';
import { getUsageSummary, updateSettings } from '../../ipc/client';

const sonnet = { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 };

const mockData = {
  totalCostCents: 42.5,
  totalInputTokens: 15000,
  totalOutputTokens: 5000,
  unpricedModels: 1,
  pricesAsOf: '2026-10-04',
  byProvider: [
    {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4',
      inputTokens: 10000,
      outputTokens: 3000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costCents: 42.5,
      price: { price: sonnet, source: 'snapshot' },
    },
    {
      providerId: 'openai_compat',
      modelId: 'my-proxy-model',
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costCents: null,
      price: null,
    },
  ],
  dailyTotals: [
    { date: '2026-08-01', costCents: 20.0, inputTokens: 8000, outputTokens: 2000 },
    { date: '2026-08-02', costCents: 22.5, inputTokens: 7000, outputTokens: 3000 },
  ],
};

vi.mock('../../ipc/client', () => ({
  getUsageSummary: vi.fn(() => Promise.resolve(mockData)),
  updateSettings: vi.fn((patch: Partial<AppSettings>) => Promise.resolve({ ...patch })),
}));

const settings = { modelPriceOverrides: [] } as unknown as AppSettings;

function renderSection(onSettingsChange = vi.fn(), onStatus = vi.fn()) {
  render(<UsageSection settings={settings} onSettingsChange={onSettingsChange} onStatus={onStatus} />);
  return { onSettingsChange, onStatus };
}

describe('UsageSection', () => {
  beforeEach(() => {
    vi.mocked(getUsageSummary).mockClear();
    vi.mocked(updateSettings).mockClear();
  });

  it('renders section header', async () => {
    renderSection();
    expect(screen.queryByText('Usage & Cost')).not.toBeNull();
    await screen.findByText('Total cost (est.)');
  });

  it('displays data after loading', async () => {
    renderSection();
    expect(await screen.findByText('Total cost (est.)')).not.toBeNull();
    expect(await screen.findByText('Anthropic')).not.toBeNull();
    expect(await screen.findByText('08-01')).not.toBeNull();
  });

  it('shows an unpriced model as "No price", never as $0, and says the total leaves it out', async () => {
    renderSection();
    expect(await screen.findByText('No price')).not.toBeNull();
    expect(
      screen.getByText('1 model has no price, so the total leaves it out. Set a price to include it.'),
    ).not.toBeNull();
    // The footer names the snapshot date.
    expect(screen.getByText(/published prices as of 2026-10-04/)).not.toBeNull();
  });

  it('saves a price for an unpriced model and re-reads the summary', async () => {
    const { onSettingsChange, onStatus } = renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Set a price for my-proxy-model' }));
    fireEvent.change(screen.getByLabelText('Input, $ per million tokens'), { target: { value: '0,5' } });
    fireEvent.change(screen.getByLabelText('Output, $ per million tokens'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save price' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1));
    expect(updateSettings).toHaveBeenCalledWith({
      modelPriceOverrides: [
        {
          providerId: 'openai_compat',
          modelId: 'my-proxy-model',
          price: { inputPerMtok: 0.5, outputPerMtok: 1.5 },
        },
      ],
    });
    await waitFor(() => expect(onSettingsChange).toHaveBeenCalled());
    expect(onStatus).toHaveBeenCalledWith('Price saved for my-proxy-model.');
    await waitFor(() => expect(getUsageSummary).toHaveBeenCalledTimes(2));
  });

  it('refuses a price that is missing or out of range without saving', async () => {
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Set a price for my-proxy-model' }));
    fireEvent.change(screen.getByLabelText('Input, $ per million tokens'), { target: { value: '-1' } });
    fireEvent.change(screen.getByLabelText('Output, $ per million tokens'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save price' }));
    expect(await screen.findByRole('alert')).not.toBeNull();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
