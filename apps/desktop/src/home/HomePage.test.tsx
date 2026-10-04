import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppSummary, ConversationSummary, DeckSummary, DraftSummary } from '../ipc/contracts';
import type { Capabilities } from '../ideas/capabilities';
import type { IdeaState } from '../ideas/ideaState';
import { IDEAS } from '../ideas/catalog';
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
import { HomePage, __resetHomeDraftForTests, greetingId, type HomePageProps } from './HomePage';

vi.mock('../ipc/client', () => ({
  getConnectorRuntimeStates: vi.fn(),
  listDecks: vi.fn(),
  listDrafts: vi.fn(),
  listMemoryItems: vi.fn(),
  listPrompts: vi.fn(),
  listWorkflowQuestions: vi.fn(),
  listWorkflowReviews: vi.fn(),
  listWorkflows: vi.fn(),
}));

const caps: Capabilities = {
  status: { network: 'ready', webSearch: 'ready', imageGen: 'ready', documents: 'ready', workspace: 'ready' },
  localModel: false,
};

const emptyIdeaState: IdeaState = {
  tried: [],
  pending: null,
  startsWithoutIdea: 0,
  rowHidden: false,
  seenRevision: null,
  knownReady: null,
  spotlight: [],
  chipOffers: {},
  chipUsed: [],
};

function chat(id: string, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return { id, displayTitle: `Chat ${id}`, updatedAt: '2026-10-01T10:00:00Z', messageCount: 4, ...over };
}

function deck(id: string, over: Partial<DeckSummary> = {}): DeckSummary {
  return {
    id,
    title: `Deck ${id}`,
    themeName: 'Plain',
    slideCount: 6,
    stage: 'slides',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-10-01T09:00:00Z',
    ...over,
  };
}

function draft(id: string, over: Partial<DraftSummary> = {}): DraftSummary {
  return { id, title: `Draft ${id}`, stage: 'draft', words: 1200, updatedAt: '2026-10-01T09:30:00Z', ...over };
}

function app(id: string, over: Partial<AppSummary> = {}): AppSummary {
  return {
    id,
    name: `App ${id}`,
    category: 'tools',
    version: '1',
    origin: 'user',
    hosts: [],
    storage: false,
    llm: false,
    sourceChanged: false,
    lastOpenedAt: '2026-10-01T08:00:00Z',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    inputs: [],
    inputsMissing: false,
    ...over,
  } as AppSummary;
}

function props(over: Partial<HomePageProps> = {}): HomePageProps {
  return {
    conversations: [],
    savedApps: [],
    ideaCaps: caps,
    ideaState: emptyIdeaState,
    collectionCount: 0,
    onAsk: vi.fn(),
    onResearch: vi.fn(),
    onOpenChat: vi.fn(),
    onOpenDeck: vi.fn(),
    onOpenApp: vi.fn(),
    onNavigate: vi.fn(),
    onAction: vi.fn(),
    onTryIdea: vi.fn(),
    onMoreIdeas: vi.fn(),
    hour: 9,
    ...over,
  };
}

async function renderHome(over: Partial<HomePageProps> = {}) {
  const p = props(over);
  const view = render(<HomePage {...p} />);
  // Let the page's own reads settle.
  await waitFor(() => expect(listDecks).toHaveBeenCalled());
  await waitFor(() => expect(listMemoryItems).toHaveBeenCalled());
  return { ...view, p };
}

beforeEach(() => {
  __resetHomeDraftForTests();
  vi.mocked(listDecks).mockResolvedValue([]);
  vi.mocked(listDrafts).mockResolvedValue([]);
  vi.mocked(listWorkflowReviews).mockResolvedValue([]);
  vi.mocked(listWorkflowQuestions).mockResolvedValue([]);
  vi.mocked(listMemoryItems).mockResolvedValue([]);
  vi.mocked(listWorkflows).mockResolvedValue([]);
  vi.mocked(listPrompts).mockResolvedValue([]);
  vi.mocked(getConnectorRuntimeStates).mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('HomePage greeting and ask box', () => {
  it('greets by the hour', () => {
    expect(greetingId(4)).toBe('home.greeting.evening');
    expect(greetingId(9)).toBe('home.greeting.morning');
    expect(greetingId(12)).toBe('home.greeting.afternoon');
    expect(greetingId(17)).toBe('home.greeting.afternoon');
    expect(greetingId(18)).toBe('home.greeting.evening');
  });

  it('says good morning and asks what we are working on', async () => {
    await renderHome({ hour: 8 });
    expect(screen.getByText('Good morning')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What are we working on?' })).toBeInTheDocument();
  });

  it('sends the text on Enter and keeps Shift+Enter for a new line', async () => {
    const { p } = await renderHome();
    const box = screen.getByLabelText('Describe what you want to do');
    fireEvent.change(box, { target: { value: '  Make a deck about Q3  ' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(p.onAsk).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(p.onAsk).toHaveBeenCalledWith('Make a deck about Q3');
    expect(box).toHaveValue('');
  });

  it('ignores an empty ask and sends from the Start button', async () => {
    const { p } = await renderHome();
    const box = screen.getByLabelText('Describe what you want to do');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(p.onAsk).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    fireEvent.change(box, { target: { value: 'Summarize this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(p.onAsk).toHaveBeenCalledWith('Summarize this');
  });

  it('suggests a different example each time it opens', async () => {
    const first = await renderHome();
    const a = screen.getByLabelText('Describe what you want to do').getAttribute('placeholder');
    first.unmount();
    await renderHome();
    const b = screen.getByLabelText('Describe what you want to do').getAttribute('placeholder');
    expect(a).not.toBe(b);
    expect(['Make a deck about…', 'Summarize…', 'Build a timer that…']).toContain(b);
  });

  it('starts things from the quick-start chips', async () => {
    const { p } = await renderHome();
    const chips = within(screen.getByRole('group', { name: 'Quick starts' }));
    fireEvent.click(chips.getByRole('button', { name: 'New chat' }));
    fireEvent.click(chips.getByRole('button', { name: 'Start a deck' }));
    fireEvent.click(chips.getByRole('button', { name: 'Make an app' }));
    fireEvent.click(chips.getByRole('button', { name: 'Ask your documents' }));
    expect((p.onAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      'new-chat',
      'start-deck',
      'browse-apps',
      'add-documents',
    ]);
  });
});

describe('HomePage needs you', () => {
  it('is absent when nothing is waiting', async () => {
    await renderHome();
    expect(screen.queryByText('Needs you')).toBeNull();
  });

  it('names a review and a memory suggestion, each with its button', async () => {
    vi.mocked(listWorkflowReviews).mockResolvedValue([
      { runId: 'r', workflowId: 'w', workflowName: 'Morning briefing' } as never,
    ]);
    vi.mocked(listMemoryItems).mockImplementation(async (status) =>
      status === 'pending' ? ([{ id: 'm1' }, { id: 'm2' }] as never) : [],
    );
    const { p } = await renderHome();
    expect(await screen.findByText('Morning briefing is waiting for your approval')).toBeInTheDocument();
    expect(screen.getByText('2 memory suggestions to review')).toBeInTheDocument();
    const rows = screen.getAllByRole('button', { name: 'Review' });
    fireEvent.click(rows[0]);
    fireEvent.click(rows[1]);
    expect((p.onAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      'open-reviews',
      'review-memory',
    ]);
  });

  it('counts questions from several workflows', async () => {
    vi.mocked(listWorkflowQuestions).mockResolvedValue([
      { workflowName: 'A' } as never,
      { workflowName: 'B' } as never,
    ]);
    await renderHome();
    expect(await screen.findByText('2 workflows have questions for you')).toBeInTheDocument();
  });
});

describe('HomePage pick up', () => {
  it('is hidden for someone with nothing yet', async () => {
    await renderHome({ conversations: [chat('empty', { displayTitle: undefined, messageCount: 0 })] });
    expect(screen.queryByText('Pick up where you left off')).toBeNull();
  });

  it('mixes chats, decks and apps by recency and opens each', async () => {
    vi.mocked(listDecks).mockResolvedValue([deck('d1'), deck('d2', { stage: 'storyline', title: 'Pitch' })]);
    const { p } = await renderHome({
      conversations: [chat('c1', { updatedAt: '2026-10-01T12:00:00Z' })],
      savedApps: [app('a1'), app('never', { lastOpenedAt: undefined })],
    });
    expect(await screen.findByRole('button', { name: 'Open deck: Deck d1' })).toBeInTheDocument();
    const names = [...document.querySelectorAll('.home-pickup-name')].map((el) => el.textContent);
    // c1 (12:00) > d1 (09:00) = d2 (09:00) > a1 (08:00); an app never opened is left out.
    expect(names).toEqual(['Chat c1', 'Deck d1', 'Pitch', 'App a1']);
    fireEvent.click(screen.getByRole('button', { name: 'Continue chat: Chat c1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open deck: Deck d1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Build deck: Pitch' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open app: App a1' }));
    expect(p.onOpenChat).toHaveBeenCalledWith('c1');
    expect(p.onOpenDeck).toHaveBeenCalledWith('d1');
    expect(p.onOpenDeck).toHaveBeenCalledWith('d2');
    expect(p.onOpenApp).toHaveBeenCalledWith('a1');
    expect(screen.getAllByText(/^Deck · 6 slides$/)).toHaveLength(2);
  });

  it('shows at most six', async () => {
    const conversations = Array.from({ length: 9 }, (_, i) => chat(`c${i}`));
    await renderHome({ conversations });
    expect(document.querySelectorAll('.home-pickup-item')).toHaveLength(6);
  });
});


describe('HomePage areas', () => {
  const tile = (area: string) => within(document.querySelector(`.home-tile[data-area="${area}"]`) as HTMLElement);

  it('shows every area as a tile with its live count', async () => {
    vi.mocked(listDecks).mockResolvedValue([deck('d1'), deck('d2'), deck('d3')]);
    vi.mocked(listWorkflows).mockResolvedValue([{ id: 'w' } as never]);
    vi.mocked(listPrompts).mockResolvedValue([{ id: 'p1' }, { id: 'p2' }] as never);
    await renderHome({ conversations: [chat('a'), chat('b')], savedApps: [app('a1')] });
    expect(screen.getByRole('heading', { name: 'Everything Conduit can do' })).toBeInTheDocument();
    expect(document.querySelectorAll('.home-tile')).toHaveLength(9);
    expect(tile('chats').getByText('2 chats')).toBeInTheDocument();
    expect(tile('apps').getByText('1 app')).toBeInTheDocument();
    await waitFor(() => expect(tile('slides').getByText('3 decks')).toBeInTheDocument());
    await waitFor(() => expect(tile('workflows').getByText('1 workflow')).toBeInTheDocument());
    await waitFor(() => expect(tile('library').getByText('2 prompts')).toBeInTheDocument());
    // An area with something in it shows its count, not an example.
    expect(tile('chats').queryByText('Help me choose between two job offers')).toBeNull();
  });

  it('does not count the empty chat the app opens on', async () => {
    await renderHome({ conversations: [chat('fresh', { displayTitle: undefined, messageCount: 0 })] });
    expect(tile('chats').queryByText(/^\d+ chats?$/)).toBeNull();
    expect(tile('chats').getByText('Help me choose between two job offers')).toBeInTheDocument();
  });

  it('opens an area and runs its action', async () => {
    const { p } = await renderHome();
    fireEvent.click(tile('slides').getByRole('button', { name: /^Slides/ }));
    fireEvent.click(tile('slides').getByRole('button', { name: 'Start a deck' }));
    fireEvent.click(tile('connectors').getByRole('button', { name: 'Add a connector' }));
    fireEvent.click(tile('library').getByRole('button', { name: 'Browse prompts' }));
    expect(p.onNavigate).toHaveBeenCalledWith('slides');
    expect(p.onAction).toHaveBeenCalledWith('start-deck');
    expect(p.onAction).toHaveBeenCalledWith('add-connector');
    expect(p.onNavigate).toHaveBeenCalledWith('library');
  });

  it('puts an empty area\'s example in the ask box when the box can run it', async () => {
    const { p } = await renderHome();
    fireEvent.click(tile('slides').getByRole('button', { name: 'Try: A 10-slide update on Q3 for the leadership team' }));
    const box = screen.getByLabelText('Describe what you want to do');
    expect(box).toHaveValue('A 10-slide update on Q3 for the leadership team');
    expect(box).toHaveFocus();
    expect(p.onAsk).not.toHaveBeenCalled();
    // One that needs setting up first is only a hint.
    expect(tile('connectors').getByText('Add GitHub, then ask about your open issues')).toBeInTheDocument();
    expect(tile('connectors').queryByRole('button', { name: /^Try:/ })).toBeNull();
  });
});

describe('HomePage Writing', () => {
  const tile = (area: string) => within(document.querySelector(`.home-tile[data-area="${area}"]`) as HTMLElement);

  it('shows a Writing tile after Slides with its draft count, and starts a draft', async () => {
    vi.mocked(listDrafts).mockResolvedValue([draft('w1'), draft('w2')]);
    const { p } = await renderHome();
    const areas = [...document.querySelectorAll('.home-tile')].map((el) => el.getAttribute('data-area'));
    expect(areas.indexOf('writing')).toBe(areas.indexOf('slides') + 1);
    await waitFor(() => expect(tile('writing').getByText('2 drafts')).toBeInTheDocument());
    fireEvent.click(tile('writing').getByRole('button', { name: /^Writing/ }));
    fireEvent.click(tile('writing').getByRole('button', { name: 'Start a draft' }));
    expect(p.onNavigate).toHaveBeenCalledWith('writing');
    expect(p.onAction).toHaveBeenCalledWith('start-draft');
  });

  it('picks up a recent draft, or its outline', async () => {
    vi.mocked(listDrafts).mockResolvedValue([draft('w1'), draft('w2', { stage: 'outline', title: 'Essay', words: 0 })]);
    const onOpenDraft = vi.fn();
    await renderHome({ onOpenDraft });
    fireEvent.click(await screen.findByRole('button', { name: 'Continue draft: Draft w1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review outline: Essay' }));
    expect(onOpenDraft).toHaveBeenCalledWith('w1');
    expect(onOpenDraft).toHaveBeenCalledWith('w2');
    expect(screen.getByText('Draft · 1,200 words')).toBeInTheDocument();
  });

  it('the Write chip starts a draft from the box text, or opens Writing when it is empty', async () => {
    const onWrite = vi.fn();
    const { p } = await renderHome({ onWrite });
    const chip = within(screen.getByRole('group', { name: 'Quick starts' })).getByRole('button', { name: 'Write' });
    fireEvent.click(chip);
    expect(p.onAction).toHaveBeenCalledWith('start-draft');
    expect(onWrite).not.toHaveBeenCalled();
    const box = screen.getByLabelText('Describe what you want to do');
    fireEvent.change(box, { target: { value: ' A post about our on-call rota ' } });
    fireEvent.click(chip);
    expect(onWrite).toHaveBeenCalledWith('A post about our on-call rota');
    expect(p.onAsk).not.toHaveBeenCalled();
    expect(box).toHaveValue('');
  });
});

describe('HomePage ask draft', () => {
  it('keeps what was typed when Home is left and opened again', async () => {
    __resetHomeDraftForTests();
    const first = await renderHome();
    fireEvent.change(screen.getByLabelText('Describe what you want to do'), { target: { value: 'Half a thought' } });
    first.unmount();
    await renderHome();
    expect(screen.getByLabelText('Describe what you want to do')).toHaveValue('Half a thought');
    fireEvent.keyDown(screen.getByLabelText('Describe what you want to do'), { key: 'Enter' });
    expect(screen.getByLabelText('Describe what you want to do')).toHaveValue('');
  });
});

describe('HomePage ideas', () => {
  it('offers three ideas and a way to more', async () => {
    const { p } = await renderHome();
    const section = within(screen.getByRole('heading', { name: 'Try something new' }).closest('section') as HTMLElement);
    const cards = section.getAllByRole('button', { name: /^Try / });
    expect(cards).toHaveLength(3);
    fireEvent.click(cards[0]);
    expect(p.onTryIdea).toHaveBeenCalledTimes(1);
    fireEvent.click(section.getByRole('button', { name: /More ideas/ }));
    expect(p.onMoreIdeas).toHaveBeenCalled();
  });

  it('puts new ideas first and labels them', async () => {
    const newest = IDEAS.filter((i) => i.addedIn > 0);
    await renderHome({ ideaState: { ...emptyIdeaState, seenRevision: 0 } });
    expect(newest.length).toBeGreaterThan(0);
    expect(screen.getAllByText('New').length).toBeGreaterThan(0);
  });

  it('is hidden when the reader turned the ideas off', async () => {
    await renderHome({ ideaState: { ...emptyIdeaState, rowHidden: true } });
    expect(screen.queryByRole('heading', { name: 'Try something new' })).toBeNull();
  });
});

describe('HomePage Research chip', () => {
  it('sends the ask box text as a Research run, and clears the box', async () => {
    const { p } = await renderHome();
    const box = screen.getByLabelText('Describe what you want to do');
    fireEvent.change(box, { target: { value: 'How do heat pumps cope with cold winters?' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Quick starts' })).getByRole('button', { name: 'Research' }));
    expect(p.onResearch).toHaveBeenCalledWith('How do heat pumps cope with cold winters?');
    expect(p.onAsk).not.toHaveBeenCalled();
    expect(box).toHaveValue('');
  });

  it('waits for a question: disabled while the box is empty', async () => {
    const { p } = await renderHome();
    const chip = within(screen.getByRole('group', { name: 'Quick starts' })).getByRole('button', { name: 'Research' });
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', 'Type a question first');
    fireEvent.click(chip);
    expect(p.onResearch).not.toHaveBeenCalled();
  });
});
