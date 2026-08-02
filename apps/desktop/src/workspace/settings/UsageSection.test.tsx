import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { UsageSection } from './UsageSection';

const mockData = {
  totalCostCents: 42.50,
  totalInputTokens: 15000,
  totalOutputTokens: 5000,
  byProvider: [
    { providerId: 'anthropic', modelId: 'claude-sonnet-4', inputTokens: 10000, outputTokens: 3000, costCents: 30.00 },
    { providerId: 'openai', modelId: 'gpt-4o', inputTokens: 5000, outputTokens: 2000, costCents: 12.50 },
  ],
  dailyTotals: [
    { date: '2026-08-01', costCents: 20.00, inputTokens: 8000, outputTokens: 2000 },
    { date: '2026-08-02', costCents: 22.50, inputTokens: 7000, outputTokens: 3000 },
  ],
};

vi.mock('../../ipc/client', () => ({
  getUsageSummary: vi.fn(() => Promise.resolve(mockData)),
}));

describe('UsageSection', () => {
  it('renders section header', async () => {
    render(<UsageSection />);
    expect(screen.queryByText('Usage & Cost')).not.toBeNull();
  });

  it('displays data after loading', async () => {
    render(<UsageSection />);
    // Wait for the stat cards to render
    const costLabel = await screen.findByText('Total cost (est.)', {}, { timeout: 3000 });
    expect(costLabel).not.toBeNull();
    // Check provider breakdown is rendered
    const provider = await screen.findByText('anthropic', {}, { timeout: 3000 });
    expect(provider).not.toBeNull();
    // Check daily chart labels
    const day1 = await screen.findByText('08-01', {}, { timeout: 3000 });
    expect(day1).not.toBeNull();
  });
});