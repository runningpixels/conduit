import { useEffect, useMemo, useState } from 'react';
import type { ProviderUsage } from '@conduit/config-schema';
import { AssistantMessage } from '../chat/AssistantMessage';
import { ChatMessageContent } from '../chat/ChatMessageContent';
import { hydrateAssistantTurn, type ChatTurn } from '../chat/conversationHydration';
import { TurnModelLine } from '../chat/TurnModelLine';
import { formatUsageParts } from '../chat/UsageSummary';
import { estimateCostCents, formatCostCents, toTokenNumber } from '../lib/costTable';
import { useModelPrices } from '../lib/useModelPrices';
import { useFormatters } from '../i18n/formatters';
import { getReplyVersions } from '../ipc/client';
import { useT } from '../i18n';

export interface CompareViewProps {
  conversationId: string;
  /** The question whose reply's versions are compared. */
  userMessageId: string;
  /** Load again when this changes: a version was put in use, a retry ended. */
  reloadKey?: unknown;
  /** The reply is the chat's last, so a version can be put in use in place. */
  canUse: boolean;
  onUse: (position: number) => void;
  onFork: (position: number) => void;
}

interface LoadedVersion {
  position: number;
  current: boolean;
  turns: ChatTurn[];
}

/** The model that wrote a version: the last of its replies that recorded one. */
function modelOf(turns: ChatTurn[]): { provider: string; model: string } | undefined {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].ranWith) return turns[i].ranWith;
  }
  return undefined;
}

/** A version's usage: its replies' token counts added up. */
function usageOf(turns: ChatTurn[]): ProviderUsage | undefined {
  const used = turns.map((turn) => turn.streamState?.usage).filter((u): u is ProviderUsage => u != null);
  if (used.length === 0) return undefined;
  const sum = (pick: (u: ProviderUsage) => bigint | number | null | undefined) =>
    used.reduce((total, u) => total + toTokenNumber(pick(u)), 0);
  const cacheRead = sum((u) => u.cacheReadTokens);
  const cacheWrite = sum((u) => u.cacheWriteTokens);
  return {
    inputTokens: BigInt(sum((u) => u.inputTokens)),
    outputTokens: BigInt(sum((u) => u.outputTokens)),
    // Left out when nothing was cached, so the line shows only what happened.
    ...(cacheRead > 0 ? { cacheReadTokens: BigInt(cacheRead) } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: BigInt(cacheWrite) } : {}),
    ...(used.length === 1 && used[0].costHint ? { costHint: used[0].costHint } : {}),
  };
}

/**
 * Compare: every version of one reply side by side in the inspector, each
 * with the model that wrote it, its usage and cost. "Use this one" puts a
 * version in use (the last reply only); "Fork" starts a new chat from it.
 */
export function CompareView({ conversationId, userMessageId, reloadKey, canUse, onUse, onFork }: CompareViewProps) {
  const t = useT();
  const fmt = useFormatters();
  const [versions, setVersions] = useState<LoadedVersion[] | null>(null);
  const lookupPrice = useModelPrices(
    useMemo(
      () =>
        (versions ?? []).flatMap((version) => {
          const ran = modelOf(version.turns);
          return ran ? [{ providerId: ran.provider, modelIds: [ran.model] }] : [];
        }),
      [versions],
    ),
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const listed = await getReplyVersions(conversationId, userMessageId);
        const loaded = await Promise.all(
          listed.map(async (version) => ({
            position: version.position,
            current: version.current,
            turns: (
              await Promise.all(
                version.messages
                  .filter((message) => message.role === 'assistant')
                  .map((message) => hydrateAssistantTurn(message)),
              )
            ).filter((turn): turn is ChatTurn => turn !== null),
          })),
        );
        if (!cancelled) setVersions(loaded);
      } catch {
        if (!cancelled) setVersions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, userMessageId, reloadKey]);

  if (versions === null) return <section className="inspector-view compare-view" aria-busy="true" />;
  if (versions.length === 0) {
    return (
      <section className="inspector-view compare-view" aria-label={t('inspector.compare.ariaLabel')}>
        <p className="inspector-empty">{t('inspector.compare.empty')}</p>
      </section>
    );
  }

  const count = versions.length;
  return (
    <section className="inspector-view compare-view" aria-label={t('inspector.compare.ariaLabel')}>
      <div className="compare-columns">
        {versions.map((version) => {
          const ran = modelOf(version.turns);
          return (
            <article
              key={version.position}
              className="compare-column"
              aria-label={t('chat.replyVersions.group', { current: version.position, count })}
              data-current={version.current || undefined}
            >
              <header className="compare-column-head">
                <h3 className="inspector-heading">
                  {t('chat.replyVersions.group', { current: version.position, count })}
                </h3>
                {version.current && <span className="compare-in-use">{t('inspector.compare.inUse')}</span>}
              </header>
              {ran && <TurnModelLine provider={ran.provider} model={ran.model} />}
              {(() => {
                const usage = usageOf(version.turns);
                if (!usage) return null;
                const cents = ran ? estimateCostCents(usage, ran.provider, lookupPrice(ran.provider, ran.model)?.price) : null;
                const tokens = formatUsageParts({ ...usage, costHint: undefined }, fmt);
                const cost = cents != null && cents > 0 ? formatCostCents(cents) : usage.costHint;
                return <p className="compare-stats">{[cost, ...tokens].filter(Boolean).join(' · ')}</p>;
              })()}
              <div className="compare-body">
                {version.turns.map((turn) =>
                  turn.streamState ? (
                    <AssistantMessage
                      key={turn.id}
                      state={turn.streamState}
                      provider={ran?.provider ?? ''}
                      modelId={ran?.model}
                      showModelLine={false}
                      isLast={false}
                    />
                  ) : (
                    <ChatMessageContent key={turn.id} content={turn.content} />
                  ),
                )}
              </div>
              <footer className="compare-actions">
                {canUse && !version.current && (
                  <button type="button" className="btn primary" onClick={() => onUse(version.position)}>
                    {t('inspector.compare.use')}
                  </button>
                )}
                <button type="button" className="btn ghost" onClick={() => onFork(version.position)}>
                  {t('inspector.compare.fork')}
                </button>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
