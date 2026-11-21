/// Home: the app's front door. One ask box to start anything, the tiles that
/// ready it to make one kind of thing (a page, an app, a deck...), what needs
/// you, and where you left off, with the way to everything you have made.
///
/// The shell hands over what it already holds (chats, apps, idea state) and
/// the callbacks that route; the page reads its own lists through the IPC
/// client, like the other pages, and keeps "needs you" fresh while it is open.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import {
  listDecks,
  listDrafts,
  listMemoryItems,
  listWorkflowActions,
  listWorkflowQuestions,
  listWorkflowResults,
  listWorkflowReviews,
} from '../ipc/client';
import type { AppSummary, ConversationSummary, DeckSummary, DraftSummary, WorkflowResult } from '../ipc/contracts';
import { AskBox } from './AskBox';
import type { HomeAction } from './areaInfo';
import { FreshResults } from './FreshResults';
import { MakeTiles } from './MakeTiles';
import type { MakeKind } from './makeKinds';
import { NO_NEEDS, NeedsYou, hasNeeds, type NeedsYouState, type WorkflowTarget } from './NeedsYou';
import { PickUp } from './PickUp';
import { buildPickUp } from './pickUpItems';

export type { HomeAction } from './areaInfo';
export type { WorkflowTarget } from './NeedsYou';

export interface HomePageProps {
  /** The shell's chat list (ordinary chats only; deck chats are left out). */
  conversations: ConversationSummary[];
  savedApps: AppSummary[];
  /** Routing happens in the shell: a deck request starts a deck, anything else a chat. */
  onAsk: (text: string) => void;
  /** The ask box's Research chip, with the box's text. */
  onResearch: (text: string) => void;
  /** Send for a picked maker tile: a deck or document opens its studio, the
   *  rest start a chat that makes that kind. */
  onMake: (kind: MakeKind, text: string) => void;
  /** "All artifacts": the Artifacts page. */
  onAllArtifacts: () => void;
  /** The Automate chip with text: describe a workflow from it. */
  onAutomate?: (text: string) => void;
  onOpenChat: (conversationId: string) => void;
  onOpenDeck: (deckId: string) => void;
  onOpenDraft?: (draftId: string) => void;
  onOpenApp: (appId: string) => void;
  onAction: (action: HomeAction, target?: WorkflowTarget) => void;
  /** The hour (0-23) for the greeting; the clock by default. For tests. */
  hour?: number;
  /** Changes when a workflow run finishes; fresh results are re-read. */
  refreshKey?: number;
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
  onAsk,
  onResearch,
  onMake,
  onAllArtifacts,
  onAutomate,
  onOpenChat,
  onOpenDeck,
  onOpenDraft,
  onOpenApp,
  onAction,
  hour,
  refreshKey,
}: HomePageProps) {
  const t = useT();
  const headingId = useId();
  const [ask, setAskState] = useState(askDraft);
  const askRef = useRef<HTMLTextAreaElement>(null);
  const setAsk = useCallback((text: string) => {
    askDraft = text;
    setAskState(text);
  }, []);
  // The maker tile picked; it readies the ask box, so the box takes focus.
  const [kind, setKindState] = useState<MakeKind | null>(null);
  const setKind = useCallback((next: MakeKind | null) => {
    setKindState(next);
    const input = askRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const [placeholderId] = useState(() => PLACEHOLDERS[opens++ % PLACEHOLDERS.length]);
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [needs, setNeeds] = useState<NeedsYouState>(NO_NEEDS);
  const [fresh, setFresh] = useState<WorkflowResult[]>([]);

  const loadNeeds = useCallback(async () => {
    const [reviews, questions, actions, pending] = await Promise.all([
      listOr(listWorkflowReviews),
      listOr(listWorkflowQuestions),
      listOr(() => listWorkflowActions()),
      listOr(() => listMemoryItems('pending')),
    ]);
    return {
      reviews: (reviews ?? []).map((r) => ({ name: r.workflowName, workflowId: r.workflowId, runId: r.runId })),
      questions: (questions ?? []).map((q) => ({ name: q.workflowName, workflowId: q.workflowId, runId: q.runId })),
      actions: (actions ?? []).map((a) => ({ name: a.workflowName, workflowId: a.workflowId, runId: a.runId })),
      memory: (pending ?? []).length,
    } satisfies NeedsYouState;
  }, []);

  const loadLists = useCallback(async () => {
    const [d, dr] = await Promise.all([listOr(listDecks), listOr(listDrafts)]);
    return { decks: d ?? [], drafts: dr ?? [] };
  }, []);

  // Everything once on open, and again when the window regains focus; "needs
  // you" also on a timer, so a review that arrives while Home is open shows.
  useEffect(() => {
    let cancelled = false;
    const refreshNeeds = () => {
      void loadNeeds().then((next) => {
        if (!cancelled) setNeeds(next);
      });
      void listOr(() => listWorkflowResults({ unreadOnly: true, limit: 3 })).then((next) => {
        if (!cancelled && next) setFresh(next);
      });
    };
    const refreshAll = () => {
      refreshNeeds();
      void loadLists().then((next) => {
        if (cancelled) return;
        setDecks(next.decks);
        setDrafts(next.drafts);
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
    // `refreshKey`: a run finished while Home is open.
  }, [loadNeeds, loadLists, refreshKey]);

  const pickUp = useMemo(
    () => buildPickUp(conversations, decks, savedApps, undefined, drafts),
    [conversations, decks, savedApps, drafts],
  );

  const greeting = t(greetingId(hour ?? new Date().getHours()));

  return (
    <section className="page home-page" aria-labelledby={headingId}>
      <div className="page-body page-body-single scroll">
        <div className="home-content">
          <header>
            <p className="home-greeting">{greeting}</p>
            <h2 id={headingId} className="home-title">
              {t('home.make.title')}
            </h2>
            <AskBox
              placeholder={t(placeholderId)}
              value={ask}
              onChange={setAsk}
              inputRef={askRef}
              onAsk={onAsk}
              onResearch={onResearch}
              onAutomate={onAutomate}
              onAction={onAction}
              kind={kind}
              onClearKind={() => setKind(null)}
              onMake={(k, text) => {
                setKindState(null);
                onMake(k, text);
              }}
            />
          </header>
          <MakeTiles picked={kind} onPick={setKind} />
          {hasNeeds(needs) && <NeedsYou needs={needs} onAction={onAction} />}
          <FreshResults results={fresh} onAction={onAction} />
          <PickUp
            items={pickUp}
            onOpenChat={onOpenChat}
            onOpenDeck={onOpenDeck}
            onOpenDraft={onOpenDraft}
            onOpenApp={onOpenApp}
            onAllArtifacts={onAllArtifacts}
          />
        </div>
      </div>
    </section>
  );
}
