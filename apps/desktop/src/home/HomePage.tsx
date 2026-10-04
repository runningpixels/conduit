/// Home: the app's front door. One ask box to start anything, what needs you,
/// where you left off, every area explained once, and a few ideas.
///
/// The shell hands over what it already holds (chats, apps, idea state) and
/// the callbacks that route; the page reads its own lists through the IPC
/// client, like the other pages, and keeps "needs you" fresh while it is open.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import {
  getConnectorRuntimeStates,
  listDecks,
  listDrafts,
  listMemoryItems,
  listPrompts,
  listWorkflowQuestions,
  listWorkflowReviews,
  listWorkflows,
} from '../ipc/client';
import type { AppSummary, ConversationSummary, DeckSummary, DraftSummary } from '../ipc/contracts';
import type { Capabilities } from '../ideas/capabilities';
import type { Idea } from '../ideas/catalog';
import type { IdeaState } from '../ideas/ideaState';
import type { Destination } from '../shell/Rail';
import { Areas } from './Areas';
import { AskBox } from './AskBox';
import { EMPTY_COUNTS, type AreaCounts, type HomeAction } from './areaInfo';
import { NO_NEEDS, NeedsYou, hasNeeds, type NeedsYouState } from './NeedsYou';
import { PickUp } from './PickUp';
import { TryIdeas } from './TryIdeas';
import { buildPickUp, isStartedChat } from './pickUpItems';

export type { HomeAction } from './areaInfo';

export interface HomePageProps {
  /** The shell's chat list (ordinary chats only; deck chats are left out). */
  conversations: ConversationSummary[];
  savedApps: AppSummary[];
  ideaCaps: Capabilities;
  ideaState: IdeaState;
  collectionCount: number | null;
  /** Routing happens in the shell: a deck request starts a deck, anything else a chat. */
  onAsk: (text: string) => void;
  /** The ask box's Research chip, with the box's text. */
  onResearch: (text: string) => void;
  /** The ask box's Write chip, with the box's text: a new draft from that brief. */
  onWrite?: (brief: string) => void;
  onOpenChat: (conversationId: string) => void;
  onOpenDeck: (deckId: string) => void;
  onOpenDraft?: (draftId: string) => void;
  onOpenApp: (appId: string) => void;
  onNavigate: (area: Destination) => void;
  onAction: (action: HomeAction) => void;
  onTryIdea: (idea: Idea) => void;
  onMoreIdeas: () => void;
  /** The hour (0-23) for the greeting; the clock by default. For tests. */
  hour?: number;
}

/** How often "needs you" is re-read while Home is open. */
const NEEDS_REFRESH_MS = 60_000;

const PLACEHOLDERS = ['home.ask.placeholder.deck', 'home.ask.placeholder.summarise', 'home.ask.placeholder.app'] as const;
// Each time Home opens it suggests the next example.
let opens = 0;
// What is typed in the ask box, kept while the app runs so leaving Home and
// coming back does not lose a half-written request.
let askDraft = '';

export function __resetHomeDraftForTests(): void {
  askDraft = '';
}

export function greetingId(hour: number): string {
  if (hour < 5 || hour >= 18) return 'home.greeting.evening';
  if (hour < 12) return 'home.greeting.morning';
  return 'home.greeting.afternoon';
}

/** A list that failed to load is an empty list: Home never shows an error. */
async function listOr<T>(read: () => Promise<T[]>): Promise<T[] | null> {
  try {
    const rows = await read();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return null;
  }
}

export function HomePage({
  conversations,
  savedApps,
  ideaCaps,
  ideaState,
  collectionCount,
  onAsk,
  onResearch,
  onWrite,
  onOpenChat,
  onOpenDeck,
  onOpenDraft,
  onOpenApp,
  onNavigate,
  onAction,
  onTryIdea,
  onMoreIdeas,
  hour,
}: HomePageProps) {
  const t = useT();
  const headingId = useId();
  const [ask, setAskState] = useState(askDraft);
  const askRef = useRef<HTMLTextAreaElement>(null);
  const setAsk = useCallback((text: string) => {
    askDraft = text;
    setAskState(text);
  }, []);
  const tryExample = useCallback(
    (text: string) => {
      setAsk(text);
      const input = askRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    },
    [setAsk],
  );
  const [placeholderId] = useState(() => PLACEHOLDERS[opens++ % PLACEHOLDERS.length]);
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [needs, setNeeds] = useState<NeedsYouState>(NO_NEEDS);
  const [lists, setLists] = useState<{ workflows: number | null; prompts: number | null; connectors: number | null; memories: number | null }>({
    workflows: null,
    prompts: null,
    connectors: null,
    memories: null,
  });

  const loadNeeds = useCallback(async () => {
    const [reviews, questions, pending] = await Promise.all([
      listOr(listWorkflowReviews),
      listOr(listWorkflowQuestions),
      listOr(() => listMemoryItems('pending')),
    ]);
    return {
      reviews: (reviews ?? []).map((r) => r.workflowName),
      questions: (questions ?? []).map((q) => q.workflowName),
      memory: (pending ?? []).length,
    } satisfies NeedsYouState;
  }, []);

  const loadLists = useCallback(async () => {
    const [d, dr, workflows, prompts, connectors, memories] = await Promise.all([
      listOr(listDecks),
      listOr(listDrafts),
      listOr(listWorkflows),
      listOr(() => listPrompts()),
      listOr(getConnectorRuntimeStates),
      listOr(() => listMemoryItems('active')),
    ]);
    return {
      decks: d ?? [],
      drafts: dr ?? [],
      counts: {
        workflows: workflows?.length ?? null,
        prompts: prompts?.length ?? null,
        connectors: connectors?.length ?? null,
        memories: memories?.length ?? null,
      },
    };
  }, []);

  // Everything once on open, and again when the window regains focus; "needs
  // you" also on a timer, so a review that arrives while Home is open shows.
  useEffect(() => {
    let cancelled = false;
    const refreshNeeds = () =>
      void loadNeeds().then((next) => {
        if (!cancelled) setNeeds(next);
      });
    const refreshAll = () => {
      refreshNeeds();
      void loadLists().then((next) => {
        if (cancelled) return;
        setDecks(next.decks);
        setDrafts(next.drafts);
        setLists(next.counts);
      });
    };
    refreshAll();
    window.addEventListener('focus', refreshAll);
    const timer = window.setInterval(refreshNeeds, NEEDS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshAll);
      window.clearInterval(timer);
    };
  }, [loadNeeds, loadLists]);

  const pickUp = useMemo(
    () => buildPickUp(conversations, decks, savedApps, undefined, drafts),
    [conversations, decks, savedApps, drafts],
  );
  const counts: AreaCounts = useMemo(
    () => ({
      ...EMPTY_COUNTS,
      // A fresh install opens on an empty chat; it is not one of yours yet.
      chats: conversations.filter(isStartedChat).length,
      decks: decks.length,
      drafts: drafts.length,
      apps: savedApps.length,
      collections: collectionCount,
      ...lists,
    }),
    [conversations, decks.length, drafts.length, savedApps.length, collectionCount, lists],
  );

  const greeting = t(greetingId(hour ?? new Date().getHours()));

  return (
    <section className="page home-page" aria-labelledby={headingId}>
      <div className="page-body page-body-single scroll">
        <div className="home-content">
          <header className="home-hero">
            <p className="home-greeting">{greeting}</p>
            <h2 id={headingId} className="home-title">
              {t('chat.view.welcomeTitle')}
            </h2>
            <AskBox
              placeholder={t(placeholderId)}
              value={ask}
              onChange={setAsk}
              inputRef={askRef}
              onAsk={onAsk}
              onResearch={onResearch}
              onWrite={onWrite}
              onAction={onAction}
            />
          </header>
          {hasNeeds(needs) && <NeedsYou needs={needs} onAction={onAction} />}
          <PickUp
            items={pickUp}
            onOpenChat={onOpenChat}
            onOpenDeck={onOpenDeck}
            onOpenDraft={onOpenDraft}
            onOpenApp={onOpenApp}
          />
          <Areas counts={counts} onNavigate={onNavigate} onAction={onAction} onTryExample={tryExample} />
          <TryIdeas caps={ideaCaps} state={ideaState} onTryIdea={onTryIdea} onMoreIdeas={onMoreIdeas} />
        </div>
      </div>
    </section>
  );
}
