import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { getUsageSummary } from '../ipc/client';
import { useSpendAlert } from './useSpendAlert';
import { ToastStack } from './ToastStack';
import { resetSpendAlertMemoryForTests } from '../lib/spendAlert';
import type { StatusState } from '../chat/statusTypes';

vi.mock('../ipc/client', () => ({
  getUsageSummary: vi.fn(),
}));

function summary(totalCostCents: number, unpricedModels = 0) {
  return {
    totalCostCents,
    totalInputTokens: 1000,
    totalOutputTokens: 1000,
    unpricedModels,
    pricesAsOf: '2026-10-04',
    byProvider: [],
    dailyTotals: [],
  };
}

function setup(thresholdUsd: number | null) {
  const onToast = vi.fn<(toast: StatusState) => void>();
  const onOpenUsage = vi.fn();
  const { result, rerender } = renderHook(
    ({ threshold }) => useSpendAlert({ thresholdUsd: threshold, onToast, onOpenUsage }),
    { initialProps: { threshold: thresholdUsd } },
  );
  return { check: () => result.current(), rerender, onToast, onOpenUsage };
}

describe('useSpendAlert', () => {
  beforeEach(() => {
    localStorage.clear();
    resetSpendAlertMemoryForTests();
    vi.mocked(getUsageSummary).mockReset();
  });

  it('does not read usage while the alert is off', () => {
    const { check } = setup(null);
    check();
    expect(getUsageSummary).not.toHaveBeenCalled();
  });

  it('stays quiet below the threshold', async () => {
    vi.mocked(getUsageSummary).mockResolvedValue(summary(500) as never);
    const { check, onToast } = setup(10);
    check();
    await waitFor(() => expect(getUsageSummary).toHaveBeenCalledWith('today'));
    await Promise.resolve();
    expect(onToast).not.toHaveBeenCalled();
  });

  it('shows one warning toast with the estimate and a link, then stops checking for the day', async () => {
    vi.mocked(getUsageSummary).mockResolvedValue(summary(1234) as never);
    const { check, onToast, onOpenUsage } = setup(10);
    check();
    await waitFor(() => expect(onToast).toHaveBeenCalledTimes(1));
    const toast = onToast.mock.calls[0][0];
    expect(toast.kind).toBe('warning');
    expect(toast.brief).toBe("Today's estimated spend is $12.34");
    expect(toast.detail).toBe(
      "That passes your daily alert of $10.00. This is an estimate, and models without a price aren't counted.",
    );
    expect(toast.action?.label).toBe('Open Usage & Cost');
    toast.action?.run();
    expect(onOpenUsage).toHaveBeenCalledTimes(1);

    // Later turns the same day: no second toast, and no usage read either.
    check();
    check();
    expect(getUsageSummary).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenCalledTimes(1);
  });

  it('says how many models used today have no price', async () => {
    vi.mocked(getUsageSummary).mockResolvedValue(summary(2000, 2) as never);
    const { check, onToast } = setup(10);
    check();
    await waitFor(() => expect(onToast).toHaveBeenCalledTimes(1));
    expect(onToast.mock.calls[0][0].detail).toBe(
      'That passes your daily alert of $10.00. This is an estimate, and it leaves out 2 models used today that have no price.',
    );
  });

  it('fires again the same day when the threshold is raised and crossed', async () => {
    vi.mocked(getUsageSummary).mockResolvedValue(summary(1500) as never);
    const { check, rerender, onToast } = setup(10);
    check();
    await waitFor(() => expect(onToast).toHaveBeenCalledTimes(1));

    rerender({ threshold: 20 });
    check();
    await waitFor(() => expect(getUsageSummary).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(onToast).toHaveBeenCalledTimes(1);

    vi.mocked(getUsageSummary).mockResolvedValue(summary(2500) as never);
    check();
    await waitFor(() => expect(onToast).toHaveBeenCalledTimes(2));
  });

  it('swallows a failed usage read', async () => {
    vi.mocked(getUsageSummary).mockRejectedValue(new Error('db busy'));
    const { check, onToast } = setup(10);
    check();
    await waitFor(() => expect(getUsageSummary).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(onToast).not.toHaveBeenCalled();
  });
});

describe('ToastStack action', () => {
  it('runs the action and dismisses the toast', async () => {
    const run = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ToastStack
        toasts={[{ brief: 'Spend', kind: 'warning', timestamp: 1, action: { label: 'Open Usage & Cost', run } }]}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open Usage & Cost' }));
    expect(run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onDismiss).toHaveBeenCalledWith(1));
  });
});
