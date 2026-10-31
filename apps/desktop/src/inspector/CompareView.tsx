import { useEffect, useState } from 'react';
import { AssistantMessage } from '../chat/AssistantMessage';
import { ChatMessageContent } from '../chat/ChatMessageContent';
import { hydrateAssistantTurn, type ChatTurn } from '../chat/conversationHydration';
import { TurnModelLine } from '../chat/TurnModelLine';
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

/**
 * Compare: every version of one reply side by side in the inspector, each
 * with the model that wrote it, its usage and cost. "Use this one" puts a
 * version in use (the last reply only); "Fork" starts a new chat from it.
 */
export function CompareView({ conversationId, userMessageId, reloadKey, canUse, onUse, onFork }: CompareViewProps) {
  const t = useT();
  const [versions, setVersions] = useState<LoadedVersion[] | null>(null);

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
