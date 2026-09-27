import { useEffect, useMemo, useState } from 'react';
import type { ProviderUsage } from '@conduit/config-schema';
import type { ChatTurn } from '../chat/conversationHydration';
import { formatUsageParts } from '../chat/UsageSummary';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { ChevronRight } from '../icons';
import { StepStatusIcon, formatStepDuration, stepDetail, stepStatusLabel } from './stepPresentation';
import { turnActivity, turnMatchesId, type ActivityStep } from './turnActivity';

export interface ActivityNetworkEntry {
  origin: string;
  method: string;
  url: string;
  status?: number;
  bytes?: number;
  ms?: number;
  error?: string;
}

export interface ActivityViewProps {
  turns: ChatTurn[];
  /** Turn to show first (a persisted id or the live request id). Default: the latest assistant turn. */
  focusTurnId?: string | null;
  /** The open page's network log (`useArtifactNetwork().log`). */
  networkLog?: ActivityNetworkEntry[];
  onSelectTurn?: (id: string) => void;
}

interface NumberedTurn {
  turn: ChatTurn;
  /** 1-based ordinal among assistant turns. */
  index: number;
  steps: ActivityStep[];
}

function StepList({ steps }: { steps: ActivityStep[] }) {
  const t = useT();
  const fmt = useFormatters();
  return (
    <ol className="activity-steps">
      {steps.map((step) => {
        const detail = stepDetail(step, t, fmt);
        return (
          <li key={step.id} className="activity-step" data-status={step.status}>
            <StepStatusIcon status={step.status} />
            <span className="sr-only">{stepStatusLabel(step.status, t)}</span>
            <span className="activity-step-body">
              <span className="activity-step-name" title={step.name || undefined}>
                {step.name || t('inspector.activity.errorName')}
              </span>
              {detail && (
                <span className="activity-step-detail" title={detail}>
                  {detail}
                </span>
              )}
            </span>
            <span className="activity-step-dur">
              {step.status === 'running' ? '…' : formatStepDuration(step.durationMs)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function num(value: bigint | number | undefined): number {
  return value == null ? 0 : Number(value);
}

/** Token totals across the chat, in the shape `formatUsageParts` reads. */
function totalUsage(turns: ChatTurn[]): { usage: ProviderUsage; turns: number } | null {
  let counted = 0;
  const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheTokens: 0 };
  const seen = { inputTokens: false, outputTokens: false, split: false, cacheTokens: false };
  let costHint: string | undefined;
  for (const turn of turns) {
    const usage = turn.streamState?.usage;
    if (!usage) continue;
    counted += 1;
    if (usage.inputTokens != null) {
      sum.inputTokens += num(usage.inputTokens);
      seen.inputTokens = true;
    }
    if (usage.outputTokens != null) {
      sum.outputTokens += num(usage.outputTokens);
      seen.outputTokens = true;
    }
    if (usage.cacheReadTokens != null && usage.cacheWriteTokens != null) {
      sum.cacheReadTokens += num(usage.cacheReadTokens);
      sum.cacheWriteTokens += num(usage.cacheWriteTokens);
      seen.split = true;
    } else if (usage.cacheTokens != null) {
      sum.cacheTokens += num(usage.cacheTokens);
      seen.cacheTokens = true;
    }
    // A cost hint is a provider-formatted string; only one turn's can be shown as-is.
    costHint = counted === 1 ? usage.costHint : undefined;
  }
  if (counted === 0) return null;
  const usage: ProviderUsage = {
    ...(seen.inputTokens ? { inputTokens: BigInt(sum.inputTokens) } : {}),
    ...(seen.outputTokens ? { outputTokens: BigInt(sum.outputTokens) } : {}),
    ...(seen.split
      ? { cacheReadTokens: BigInt(sum.cacheReadTokens), cacheWriteTokens: BigInt(sum.cacheWriteTokens) }
      : seen.cacheTokens
        ? { cacheTokens: BigInt(sum.cacheTokens) }
        : {}),
    ...(costHint ? { costHint } : {}),
  };
  return { usage, turns: counted };
}

/**
 * Inspector → Activity: the focused turn's steps as a timeline, its web
 * searches, a "This chat" summary, then earlier turns as collapsed rows.
 */
export function ActivityView({ turns, focusTurnId, networkLog = [], onSelectTurn }: ActivityViewProps) {
  const t = useT();
  const fmt = useFormatters();
  const [localFocus, setLocalFocus] = useState<string | null>(focusTurnId ?? null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => setLocalFocus(focusTurnId ?? null), [focusTurnId]);

  const numbered = useMemo<NumberedTurn[]>(() => {
    const out: NumberedTurn[] = [];
    for (const turn of turns) {
      if (turn.role !== 'assistant') continue;
      out.push({ turn, index: out.length + 1, steps: turnActivity(turn) });
    }
    return out;
  }, [turns]);

  const focused =
    (localFocus ? numbered.find((n) => turnMatchesId(n.turn, localFocus)) : undefined) ??
    numbered[numbered.length - 1];

  const allSteps = numbered.flatMap((n) => n.steps);
  const hasActivity = allSteps.length > 0 || networkLog.length > 0;

  if (!hasActivity) {
    return (
      <section className="inspector-view activity-view" aria-label={t('inspector.activity.ariaLabel')}>
        <p className="inspector-empty">{t('inspector.activity.empty')}</p>
      </section>
    );
  }

  const searches = (focused?.steps ?? []).filter((s) => s.kind === 'search');

  const toolCounts = new Map<string, number>();
  for (const step of allSteps) {
    if (step.kind === 'error') continue;
    toolCounts.set(step.name, (toolCounts.get(step.name) ?? 0) + 1);
  }
  const documents = [
    ...new Set(
      allSteps
        .filter((s) => s.kind === 'document' && s.status === 'done' && s.documentAction !== 'read' && s.label)
        .map((s) => s.label),
    ),
  ];
  const sites = new Map<string, { requests: number; failed: number }>();
  for (const entry of networkLog) {
    const site = sites.get(entry.origin) ?? { requests: 0, failed: 0 };
    site.requests += 1;
    if (entry.error || (entry.status != null && entry.status >= 400)) site.failed += 1;
    sites.set(entry.origin, site);
  }
  const usage = totalUsage(turns);
  const usageParts = usage ? formatUsageParts(usage.usage, fmt) : [];
  const searchQueries = turns.reduce((n, turn) => n + (turn.streamState?.searchCost ?? 0), 0);

  const earlier = numbered.filter((n) => n !== focused && n.steps.length > 0).reverse();

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function select(id: string) {
    setLocalFocus(id);
    onSelectTurn?.(id);
  }

  return (
    <section className="inspector-view activity-view" aria-label={t('inspector.activity.ariaLabel')}>
      {focused && (
        <div className="inspector-section">
          <h3 className="inspector-heading">{t('inspector.turnLabel', { index: focused.index })}</h3>
          {focused.steps.length > 0 ? (
            <StepList steps={focused.steps} />
          ) : (
            <p className="inspector-note">{t('inspector.activity.noSteps')}</p>
          )}
        </div>
      )}

      {searches.length > 0 && (
        <div className="inspector-section">
          <h3 className="inspector-heading">{t('chat.search.title')}</h3>
          <ul className="inspector-list">
            {searches.map((s) => (
              <li key={s.id} className="inspector-row">
                <span className="inspector-row-main" title={s.label || undefined}>
                  {s.label || t('chat.search.searchingPlaceholder')}
                </span>
                <span className="inspector-row-meta">
                  {t('chat.search.sourceCount', { count: s.sourceCount ?? 0 })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="inspector-section">
        <h3 className="inspector-heading">{t('inspector.activity.thisChat')}</h3>
        {toolCounts.size > 0 && (
          <>
            <h4 className="inspector-subheading">{t('inspector.activity.toolsUsed')}</h4>
            <ul className="inspector-list">
              {[...toolCounts].map(([name, count]) => (
                <li key={name} className="inspector-row">
                  <span className="inspector-row-main activity-step-name" title={name}>
                    {name}
                  </span>
                  <span className="inspector-row-meta">{t('inspector.activity.callCount', { count })}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {searchQueries > 0 && (
          <p className="inspector-note">{t('chat.search.queryCount', { count: searchQueries })}</p>
        )}
        {sites.size > 0 && (
          <>
            <h4 className="inspector-subheading">{t('inspector.activity.sitesContacted')}</h4>
            <ul className="inspector-list">
              {[...sites].map(([origin, site]) => (
                <li key={origin} className="inspector-row">
                  <span className="inspector-row-main activity-step-name" title={origin}>
                    {origin}
                  </span>
                  <span className="inspector-row-meta">
                    {[
                      t('inspector.activity.requestCount', { count: site.requests }),
                      site.failed > 0 ? t('inspector.activity.failedCount', { count: site.failed }) : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {documents.length > 0 && (
          <>
            <h4 className="inspector-subheading">{t('inspector.activity.documents')}</h4>
            <ul className="inspector-list">
              {documents.map((title) => (
                <li key={title} className="inspector-row">
                  <span className="inspector-row-main" title={title}>
                    {title}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        {usage && usageParts.length > 0 && (
          <>
            <h4 className="inspector-subheading">{t('inspector.activity.usage')}</h4>
            <p className="inspector-note activity-usage">
              {usageParts.join(' · ')}
              {' · '}
              {t('inspector.activity.usageTurns', { count: usage.turns })}
            </p>
          </>
        )}
      </div>

      {earlier.length > 0 && (
        <div className="inspector-section">
          <h3 className="inspector-heading">{t('inspector.activity.earlier')}</h3>
          <ul className="inspector-list">
            {earlier.map((n) => {
              const open = expanded.has(n.turn.id);
              return (
                <li key={n.turn.id} className="activity-turn" data-open={open ? 'true' : 'false'}>
                  <button
                    type="button"
                    className="activity-turn-head"
                    aria-expanded={open}
                    onClick={() => toggle(n.turn.id)}
                  >
                    <ChevronRight className="activity-turn-chev" />
                    <span>{t('inspector.activity.turnRow', { index: n.index, count: n.steps.length })}</span>
                  </button>
                  {open && (
                    <div className="activity-turn-body">
                      <StepList steps={n.steps} />
                      <button type="button" className="btn ghost" onClick={() => select(n.turn.id)}>
                        {t('inspector.activity.select')}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
