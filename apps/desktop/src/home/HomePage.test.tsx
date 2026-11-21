import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppSummary, ConversationSummary, DeckSummary, DraftSummary } from '../ipc/contracts';
import {
  listDecks,
  listDrafts,
  listMemoryItems,
  listWorkflowActions,
  listWorkflowQuestions,
  listWorkflowResults,
  listWorkflowReviews,
} from '../ipc/client';
import { HomePage, __resetHomeDraftForTests, greetingId, type HomePageProps } from './HomePage';

vi.mock('../ipc/client', () => ({
  listDecks: vi.fn(),
  listDrafts: vi.fn(),
  listMemoryItems: vi.fn(),
  listWorkflowActions: vi.fn(),
  listWorkflowQuestions: vi.fn(),
  listWorkflowResults: vi.fn(),
  listWorkflowReviews: vi.fn(),
}));

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
    onAsk: vi.fn(),
    onResearch: vi.fn(),
    onOpenChat: vi.fn(),
    onOpenDeck: vi.fn(),
    onOpenApp: vi.fn(),
    onMake: vi.fn(),
    onAllArtifacts: vi.fn(),
    onAction: vi.fn(),
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
  vi.mocked(listWorkflowResults).mockResolvedValue([]);
  vi.mocked(listMemoryItems).mockResolvedValue([]);
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

  it('says good morning and asks what we are making', async () => {
    await renderHome({ hour: 8 });
    expect(screen.getByText('Good morning')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What are we making?' })).toBeInTheDocument();
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
    fireEvent.click(chips.getByRole('button', { name: 'Ask your documents' }));
    expect((p.onAction as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual(['new-chat', 'add-documents']);
    // Making things is the tiles' job now, not the chips'.
    expect(chips.queryByRole('button', { name: 'Start a deck' })).toBeNull();
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

  it('hands the waiting workflow and run to the shell, for a review and for a question', async () => {
    vi.mocked(listWorkflowReviews).mockResolvedValue([
      { runId: 'rr', workflowId: 'wr', workflowName: 'Review me' } as never,
    ]);
    vi.mocked(listWorkflowQuestions).mockResolvedValue([
      { runId: 'rq', workflowId: 'wq', workflowName: 'Ask me' } as never,
    ]);
    const { p } = await renderHome();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }));
    expect(p.onAction).toHaveBeenNthCalledWith(1, 'open-reviews', { workflowId: 'wr', runId: 'rr' });
    expect(p.onAction).toHaveBeenNthCalledWith(2, 'open-reviews', { workflowId: 'wq', runId: 'rq' });
  });

  it('counts questions from several workflows', async () => {
    vi.mocked(listWorkflowQuestions).mockResolvedValue([
      { workflowName: 'A' } as never,
      { workflowName: 'B' } as never,
    ]);
    await renderHome();
    expect(await screen.findByText('2 workflows have questions for you')).toBeInTheDocument();
  });

  it('points an outside action at the Inbox', async () => {
    vi.mocked(listWorkflowActions).mockResolvedValue([
      { runId: 'ra', workflowId: 'wa', workflowName: 'Standup post' } as never,
    ]);
    const { p } = await renderHome();
    expect(await screen.findByText('Standup post wants to send something')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));
    expect(p.onAction).toHaveBeenCalledWith('open-inbox');
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

  it('links to every artifact', async () => {
    const { p } = await renderHome({ conversations: [chat('c1')] });
    fireEvent.click(screen.getByRole('button', { name: 'All artifacts' }));
    expect(p.onAllArtifacts).toHaveBeenCalled();
  });
});


describe('HomePage make something new', () => {
  const box = () => screen.getByLabelText('Describe what you want to do');
  const tiles = () => within(screen.getByRole('heading', { name: 'Make something new' }).closest('section') as HTMLElement);

  it('offers six kinds to make, in order', async () => {
    await renderHome();
    const names = tiles()
      .getAllByRole('button')
      .map((b) => b.querySelector('.home-make-name')?.textContent);
    expect(names).toEqual(['Page', 'App', 'Deck', 'Document', 'Spreadsheet', 'Image']);
  });

  it('readies the ask box for the kind picked, and clears it on a second pick or the chip', async () => {
    await renderHome();
    const page = tiles().getByRole('button', { name: /^Page/ });
    fireEvent.click(page);
    expect(page).toHaveAttribute('aria-pressed', 'true');
    expect(box()).toHaveAttribute('placeholder', 'What should the page explain? Attach a file, or name a topic…');
    expect(box()).toHaveFocus();
    fireEvent.click(page);
    expect(page).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(tiles().getByRole('button', { name: /^Image/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear Image' }));
    expect(screen.queryByRole('button', { name: 'Clear Image' })).toBeNull();
  });

  it('sends a chat-made kind with its lead-in, not as a plain ask', async () => {
    const { p } = await renderHome();
    fireEvent.click(tiles().getByRole('button', { name: /^Spreadsheet/ }));
    expect(screen.getByRole('button', { name: 'Start' })).toBeDisabled();
    fireEvent.change(box(), { target: { value: ' Our team budget ' } });
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(p.onMake).toHaveBeenCalledWith('sheet', 'Make a spreadsheet: Our team budget');
    expect(p.onAsk).not.toHaveBeenCalled();
    expect(box()).toHaveValue('');
    // Sent: the box is back to asking anything.
    expect(screen.queryByRole('button', { name: 'Clear Spreadsheet' })).toBeNull();
  });

  it('opens a deck or a document with nothing typed, and passes typed text as it is', async () => {
    const { p } = await renderHome();
    fireEvent.click(tiles().getByRole('button', { name: /^Deck/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(p.onMake).toHaveBeenCalledWith('deck', '');
    fireEvent.click(tiles().getByRole('button', { name: /^Document/ }));
    fireEvent.change(box(), { target: { value: 'A post about our on-call rota' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(p.onMake).toHaveBeenCalledWith('document', 'A post about our on-call rota');
  });
});

describe('HomePage Writing', () => {
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

  it('the Automate chip describes a workflow from the box text, or opens the picker when empty', async () => {
    const onAutomate = vi.fn();
    const { p } = await renderHome({ onAutomate });
    const chip = within(screen.getByRole('group', { name: 'Quick starts' })).getByRole('button', { name: 'Automate' });
    fireEvent.click(chip);
    expect(p.onAction).toHaveBeenCalledWith('new-workflow');
    expect(onAutomate).not.toHaveBeenCalled();
    const box = screen.getByLabelText('Describe what you want to do');
    fireEvent.change(box, { target: { value: ' Read two sites and save a briefing ' } });
    fireEvent.click(chip);
    expect(onAutomate).toHaveBeenCalledWith('Read two sites and save a briefing');
    // The text is not sent as a chat, whatever it says.
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

describe('HomePage fresh results', () => {
  const result = (id: string, over: Record<string, unknown> = {}) =>
    ({
      workflowName: 'Morning briefing',
      run: {
        id,
        workflowId: 'w1',
        status: 'completed',
        startedAt: '2026-10-11T07:00:00Z',
        finishedAt: '2026-10-11T07:01:00Z',
        seenAt: null,
        outputs: [{ kind: 'document', title: `Briefing ${id}`, stepId: 'save', preview: 'Three stories today' }],
        ...over,
      },
    }) as never;

  it('is absent when nothing is unread', async () => {
    await renderHome();
    expect(screen.queryByText('Fresh from your workflows')).toBeNull();
    expect(listWorkflowResults).toHaveBeenCalledWith({ unreadOnly: true, limit: 3 });
  });

  it('shows unread results and opens one on the Workflows page', async () => {
    vi.mocked(listWorkflowResults).mockResolvedValue([result('r1'), result('r2')]);
    const { p } = await renderHome();
    expect(await screen.findByText('Fresh from your workflows')).toBeInTheDocument();
    expect(screen.getAllByText('Three stories today')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: /Briefing r2/ }));
    expect(p.onAction).toHaveBeenCalledWith('open-results', { workflowId: 'w1', runId: 'r2' });
    fireEvent.click(screen.getByRole('button', { name: 'See all results' }));
    expect(p.onAction).toHaveBeenLastCalledWith('open-results');
  });

  it('titles a failed run by its workflow', async () => {
    vi.mocked(listWorkflowResults).mockResolvedValue([result('r3', { status: 'failed', outputs: [], error: 'Timed out' })]);
    await renderHome();
    expect(await screen.findByText('Failed: Morning briefing')).toBeInTheDocument();
    expect(screen.getByText('Timed out')).toBeInTheDocument();
  });
});
