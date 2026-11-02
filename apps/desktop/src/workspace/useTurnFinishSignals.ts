/// "Is it done yet?" signals for a turn the user wasn't watching: a "Done"
/// mark on the chat in the sidebar until they open it, the document panel's
/// "Editing…" → "Done" badge, and a system notification when Conduit isn't in
/// front and the turn ran long.
///
/// Driven by the one running-chat slot `ChatView` reports (`RunStatus`): a
/// turn starts when a chat takes the slot and ends when it lets go.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunStatus } from '../chat/ChatView';
import type { DocumentToolActivity } from '../chat/agentTools';

/** A turn shorter than this finished while the user was still looking, most
 *  likely; it gets no system notification. */
export const NOTIFY_AFTER_MS = 30_000;

export type DocumentEditState = 'editing' | 'done';

interface DocEdits {
  conversationId: string;
  editing: ReadonlySet<string>;
  done: ReadonlySet<string>;
}

export interface TurnFinishSignalsOptions {
  runStatus: RunStatus | null;
  activeConversationId: string | null;
  /** The chat's title for the notification. */
  titleOf: (conversationId: string) => string;
  notifyEnabled: boolean;
  notify: (title: string, body: string) => void;
  notifyTitle: string;
  /** Overridable for tests. */
  hasFocus?: () => boolean;
  now?: () => number;
}

export function useTurnFinishSignals({
  runStatus,
  activeConversationId,
  titleOf,
  notifyEnabled,
  notify,
  notifyTitle,
  hasFocus = () => document.hasFocus(),
  now = () => Date.now(),
}: TurnFinishSignalsOptions) {
  const [finishedUnseen, setFinishedUnseen] = useState<ReadonlySet<string>>(() => new Set());
  const [docEdits, setDocEdits] = useState<DocEdits | null>(null);

  // Read inside the transition effect without re-running it.
  const latest = useRef({ activeConversationId, titleOf, notifyEnabled, notify, notifyTitle, hasFocus, now });
  latest.current = { activeConversationId, titleOf, notifyEnabled, notify, notifyTitle, hasFocus, now };

  const runRef = useRef<{ conversationId: string; startedAt: number } | null>(null);
  const runningId = runStatus?.conversationId ?? null;

  useEffect(() => {
    const l = latest.current;
    const previous = runRef.current;
    if (previous && previous.conversationId !== runningId) {
      const id = previous.conversationId;
      const focused = l.hasFocus();
      if (id !== l.activeConversationId || !focused) {
        setFinishedUnseen((current) => new Set(current).add(id));
      }
      setDocEdits((current) =>
        current && current.conversationId === id
          ? { conversationId: id, editing: new Set(), done: new Set([...current.done, ...current.editing]) }
          : current,
      );
      if (!focused && l.notifyEnabled && l.now() - previous.startedAt >= NOTIFY_AFTER_MS) {
        l.notify(l.notifyTitle, l.titleOf(id));
      }
      runRef.current = null;
    }
    if (runningId && runRef.current?.conversationId !== runningId) {
      runRef.current = { conversationId: runningId, startedAt: l.now() };
      setFinishedUnseen((current) => {
        if (!current.has(runningId)) return current;
        const next = new Set(current);
        next.delete(runningId);
        return next;
      });
      setDocEdits({ conversationId: runningId, editing: new Set(), done: new Set() });
    }
  }, [runningId]);

  const markSeen = useCallback((conversationId: string | null) => {
    if (!conversationId) return;
    setFinishedUnseen((current) => {
      if (!current.has(conversationId)) return current;
      const next = new Set(current);
      next.delete(conversationId);
      return next;
    });
  }, []);

  // Opening the chat, or coming back to the window while it is on screen,
  // counts as seeing it.
  useEffect(() => {
    if (latest.current.hasFocus()) markSeen(activeConversationId);
    const onFocus = () => markSeen(latest.current.activeConversationId);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [activeConversationId, markSeen]);

  /** Feed every document tool event here: a document the running turn touches
   *  shows "Editing…" until the turn ends. */
  const noteDocumentActivity = useCallback(
    (activity: DocumentToolActivity) => {
      const id = activity.artifactId;
      const conversationId = runRef.current?.conversationId;
      if (!id || !conversationId || activity.phase === 'error') return;
      setDocEdits((current) => {
        const base =
          current && current.conversationId === conversationId
            ? current
            : { conversationId, editing: new Set<string>(), done: new Set<string>() };
        if (base.editing.has(id)) return base;
        return { ...base, editing: new Set(base.editing).add(id) };
      });
    },
    [],
  );

  const documentEditState = useCallback(
    (conversationId: string | null, artifactId: string | undefined): DocumentEditState | undefined => {
      if (!docEdits || !artifactId || docEdits.conversationId !== conversationId) return undefined;
      if (docEdits.editing.has(artifactId)) return 'editing';
      if (docEdits.done.has(artifactId)) return 'done';
      return undefined;
    },
    [docEdits],
  );

  return { finishedUnseen, noteDocumentActivity, documentEditState };
}
