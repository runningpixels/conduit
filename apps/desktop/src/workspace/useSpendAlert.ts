import { useCallback, useRef } from 'react';
import { getUsageSummary } from '../ipc/client';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { makeStatus, type StatusState } from '../chat/statusTypes';
import {
  readSpendAlertMark,
  shouldShowSpendAlert,
  spendAlertPending,
  usageDay,
  writeSpendAlertMark,
} from '../lib/spendAlert';

interface UseSpendAlertOptions {
  /** `AppSettings.dailySpendAlertUsd`: `null`/absent is off. */
  thresholdUsd: number | null | undefined;
  /** Show the notice (App's toast stack). */
  onToast: (toast: StatusState) => void;
  /** Open Settings → Usage & Cost. */
  onOpenUsage: () => void;
}

/**
 * Returns a check to run after a chat turn ends. When today's estimated spend
 * has passed the user's daily alert, it shows one toast for the day, linking
 * to Usage & Cost. It never blocks, cancels or delays anything: the turn has
 * already ended, the check runs in the background, and any failure to read
 * usage is swallowed (an alert is not worth an error toast).
 */
export function useSpendAlert({ thresholdUsd, onToast, onOpenUsage }: UseSpendAlertOptions): () => void {
  const t = useT();
  const fmt = useFormatters();
  // Read through a ref so the returned check is stable and always sees the
  // latest threshold, translations and handlers.
  const latest = useRef({ thresholdUsd, onToast, onOpenUsage, t, fmt });
  latest.current = { thresholdUsd, onToast, onOpenUsage, t, fmt };
  const inFlight = useRef(false);

  return useCallback(() => {
    const day = usageDay(new Date());
    if (!spendAlertPending(latest.current.thresholdUsd, day, readSpendAlertMark())) return;
    if (inFlight.current) return;
    inFlight.current = true;
    void getUsageSummary('today')
      .then((summary) => {
        const { thresholdUsd: threshold, onToast: toast, onOpenUsage: open, t: tr, fmt: f } = latest.current;
        if (
          !shouldShowSpendAlert({
            thresholdUsd: threshold,
            todayCostCents: summary.totalCostCents,
            day,
            last: readSpendAlertMark(),
          })
        ) {
          return;
        }
        const thresholdUsd = threshold as number;
        writeSpendAlertMark({ day, thresholdUsd });
        const thresholdText = f.money(thresholdUsd * 100);
        const detail =
          summary.unpricedModels > 0
            ? tr('settings.usage.spendAlert.toastDetailUnpriced', {
                threshold: thresholdText,
                count: summary.unpricedModels,
              })
            : tr('settings.usage.spendAlert.toastDetail', { threshold: thresholdText });
        toast({
          ...makeStatus(
            tr('settings.usage.spendAlert.toastBrief', { amount: f.money(summary.totalCostCents) }),
            'warning',
            'settings',
            detail,
          ),
          action: { label: tr('settings.usage.spendAlert.toastAction'), run: open },
        });
      })
      .catch(() => {
        /* usage unreadable: no alert this turn, try again after the next */
      })
      .finally(() => {
        inFlight.current = false;
      });
  }, []);
}
