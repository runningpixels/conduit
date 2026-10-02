import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeckDetail, DeckSlide } from '../ipc/contracts';
import { DeckWorkspace, type DeckWorkspaceProps } from './DeckWorkspace';
import { STARTER_THEMES } from './themes';

const slide = (id: string, position: number): DeckSlide => ({
  id,
  position,
  layout: 'statement',
  html: `<h1 class="headline">${id}</h1>`,
  notes: '',
  slots: [],
});

function makeDeck(over: Partial<DeckDetail> = {}): DeckDetail {
  return {
    id: 'd1',
    title: 'Launch',
    themeName: 'ink',
    themeCss: STARTER_THEMES[0].css,
    stage: 'slides',
    storyline: [],
    slides: [slide('a', 0), slide('b', 1)],
    assumptions: '',
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
    ...over,
  };
}

function props(over: Partial<DeckWorkspaceProps> = {}): DeckWorkspaceProps {
  return {
    deck: makeDeck(),
    loading: false,
    busyTool: null,
    colorScheme: 'dark',
    onRename: vi.fn(),
    onSetTheme: vi.fn(),
    onSetStoryline: vi.fn(),
    onBuild: vi.fn(),
    onListSnapshots: vi.fn().mockResolvedValue([]),
    onRestore: vi.fn().mockResolvedValue(undefined),
    historyRevision: 0,
    ...over,
  };
}

describe('DeckWorkspace', () => {
  it('keeps saved custom themes in the theme picker after switching away', () => {
    const p = props({
      savedThemes: [{ name: 'Ember', css: '.ember{}', updatedAt: '2026-10-01T10:00:00Z' }],
    });
    render(<DeckWorkspace {...p} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Ink', 'Paper', 'Ember']);
    fireEvent.change(select, { target: { value: 'Ember' } });
    expect(p.onSetTheme).toHaveBeenCalledWith('Ember', '.ember{}');
  });

  it('shows the storyline editor while the deck is an outline', () => {
    const p = props({
      deck: makeDeck({ stage: 'storyline', slides: [], storyline: [{ id: 'l1', text: 'Why now' }] }),
    });
    render(<DeckWorkspace {...p} />);
    expect(screen.getByDisplayValue('Why now')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Build slides' }));
    expect(p.onBuild).toHaveBeenCalled();
  });

  it('moves between slides with the arrow keys and jumps to a new slide', () => {
    const p = props();
    const { rerender } = render(<DeckWorkspace {...p} />);
    expect(screen.getAllByText('Slide 1 of 2').length).toBeGreaterThan(0);
    const stage = screen.getByRole('group', { name: 'Slide 1 of 2' });
    fireEvent.keyDown(stage, { key: 'ArrowRight' });
    expect(screen.getByText('Slide 2 of 2', { selector: '.deck-stage-count' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Slide 2 of 2' }), { key: 'ArrowRight' });
    expect(screen.getByText('Slide 2 of 2', { selector: '.deck-stage-count' })).toBeTruthy();
    rerender(<DeckWorkspace {...p} deck={makeDeck({ slides: [slide('a', 0), slide('b', 1), slide('c', 2)] })} />);
    expect(screen.getByText('Slide 3 of 3', { selector: '.deck-stage-count' })).toBeTruthy();
    rerender(<DeckWorkspace {...p} deck={makeDeck({ slides: [slide('a', 0)] })} />);
    expect(screen.getByText('Slide 1 of 1', { selector: '.deck-stage-count' })).toBeTruthy();
  });

  it('shows an updating label while a deck tool runs', () => {
    render(<DeckWorkspace {...props({ busyTool: 'add_slide' })} />);
    expect(screen.getByText('Updating…')).toBeTruthy();
  });

  it('switches theme and lists a custom theme name', () => {
    const p = props({ deck: makeDeck({ themeName: 'Custom' }) });
    render(<DeckWorkspace {...p} />);
    const select = screen.getByLabelText('Theme') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['ink', 'paper', 'Custom']);
    fireEvent.change(select, { target: { value: 'paper' } });
    expect(p.onSetTheme).toHaveBeenCalledWith('paper', STARTER_THEMES[1].css);
  });

  it('toggles Script, which excludes History, and only shows with the words callbacks', () => {
    const plain = render(<DeckWorkspace {...props()} />);
    expect(screen.queryByRole('button', { name: 'Script' })).toBeNull();
    plain.unmount();

    const p = props({
      onEditWords: vi.fn().mockResolvedValue(undefined),
      onSetPinned: vi.fn().mockResolvedValue(undefined),
      onReplace: vi.fn().mockResolvedValue({ total: 0, applied: false, slides: [] }),
    });
    render(<DeckWorkspace {...p} />);
    const words = screen.getByRole('button', { name: 'Script' });
    fireEvent.click(words);
    expect(screen.getByRole('complementary', { name: 'Script' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.queryByRole('complementary', { name: 'Script' })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'History' })).toBeTruthy();
    fireEvent.click(words);
    expect(screen.queryByRole('complementary', { name: 'History' })).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Script' })).toBeTruthy();
  });

  it('opens the Script find bar, focused, on Ctrl+H', () => {
    const p = props({
      onEditWords: vi.fn().mockResolvedValue(undefined),
      onSetPinned: vi.fn().mockResolvedValue(undefined),
      onReplace: vi.fn().mockResolvedValue({ total: 0, applied: false, slides: [] }),
    });
    render(<DeckWorkspace {...p} />);
    fireEvent.keyDown(screen.getByRole('group', { name: 'Slide 1 of 2' }), { key: 'h', ctrlKey: true });
    expect(document.activeElement).toBe(screen.getByLabelText('Find'));
  });

  it('puts the Script drawer beside the stage column so nothing covers the stage controls', () => {
    const p = props({
      onEditWords: vi.fn().mockResolvedValue(undefined),
      onSetPinned: vi.fn().mockResolvedValue(undefined),
      onReplace: vi.fn().mockResolvedValue({ total: 0, applied: false, slides: [] }),
    });
    const { container } = render(<DeckWorkspace {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Script' }));
    const drawer = screen.getByRole('complementary', { name: 'Script' });
    const stageCol = container.querySelector('.deck-stage-col') as HTMLElement;
    const nav = container.querySelector('.deck-stage-nav') as HTMLElement;
    expect(drawer.parentElement).toBe(stageCol.parentElement);
    expect(drawer.contains(nav)).toBe(false);
    expect(drawer.contains(stageCol)).toBe(false);
    expect(stageCol.contains(drawer)).toBe(false);
    expect(stageCol.contains(screen.getByRole('button', { name: 'Next slide' }))).toBe(true);
  });

  it('marks overflowing slides with a dot and a caption, and reports them', async () => {
    const onOverflowChange = vi.fn();
    const onAskToFix = vi.fn();
    const { container } = render(<DeckWorkspace {...props({ onOverflowChange, onAskToFix })} />);
    await waitFor(() => expect(container.querySelector('.deck-stage iframe')).toBeTruthy());
    const frame = container.querySelector('.deck-stage iframe') as HTMLIFrameElement;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: frame.contentWindow,
          data: {
            type: 'conduit-deck-event',
            event: 'overflow',
            slides: [
              { id: 'a', px: 0 },
              { id: 'b', px: 90 },
            ],
          },
        }),
      );
    });
    expect(onOverflowChange).toHaveBeenCalledWith({ b: 90 });
    expect(screen.getAllByRole('img', { name: 'Text runs off slide 2' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Ask to fix' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask to fix' }));
    expect(onAskToFix).toHaveBeenCalledWith(expect.stringContaining('Slide 2 has text running off the bottom by 90px.'));
  });

  it('restores from history only after an inline confirm', async () => {
    const p = props({
      onListSnapshots: vi.fn().mockResolvedValue([
        { id: 's2', cause: 'ai-turn', label: 'Add a stats slide', slideCount: 3, createdAt: '2026-10-01T10:05:00Z' },
        { id: 's1', cause: 'created', label: 'Deck created', slideCount: 0, createdAt: '2026-10-01T10:00:00Z' },
      ]),
    });
    render(<DeckWorkspace {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByText('Add a stats slide')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(p.onRestore).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0]);
    await waitFor(() => expect(p.onRestore).toHaveBeenCalledWith('s1'));
  });

  describe('studio layout', () => {
    beforeEach(() => window.localStorage.clear());

    const studioProps = (over: Partial<DeckWorkspaceProps> = {}) =>
      props({
        layout: 'studio',
        onBack: vi.fn(),
        onEditWords: vi.fn().mockResolvedValue(undefined),
        onSetPinned: vi.fn().mockResolvedValue(undefined),
        onReplace: vi.fn().mockResolvedValue({ total: 0, applied: false, slides: [] }),
        ...over,
      });

    it('renders the studio header and no Script or History drawers or buttons', () => {
      const p = studioProps();
      const { container } = render(<DeckWorkspace {...p} />);
      expect(container.querySelector('.studio-head')).not.toBeNull();
      expect(container.querySelector('.deck-head')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Script' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'History' })).toBeNull();
      expect(screen.queryByRole('complementary', { name: 'Script' })).toBeNull();
      expect(screen.queryByRole('complementary', { name: 'History' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /All decks/ }));
      expect(p.onBack).toHaveBeenCalled();
    });

    it('reports a selected slot and opens Script find on Ctrl+H', async () => {
      const onSlotSelected = vi.fn();
      const onOpenScriptFind = vi.fn();
      const { container } = render(<DeckWorkspace {...studioProps({ onSlotSelected, onOpenScriptFind })} />);
      await waitFor(() => expect(container.querySelector('.deck-stage iframe')).toBeTruthy());
      const frame = container.querySelector('.deck-stage iframe') as HTMLIFrameElement;
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: frame.contentWindow,
            data: { type: 'conduit-deck-event', event: 'slot-select', slideId: 'a', index: 2, name: 'bullet-1' },
          }),
        );
      });
      expect(onSlotSelected).toHaveBeenCalledWith('a', 2, 'bullet-1');
      fireEvent.keyDown(screen.getByRole('group', { name: 'Slide 1 of 2' }), { key: 'h', ctrlKey: true });
      expect(onOpenScriptFind).toHaveBeenCalled();
    });

    it('moves the stage when asked to show a slide', () => {
      const p = studioProps();
      const { rerender } = render(<DeckWorkspace {...p} />);
      rerender(<DeckWorkspace {...p} slideRequest={{ index: 1, nonce: 1 }} />);
      expect(screen.getByText('Slide 2 of 2', { selector: '.deck-stage-count' })).toBeTruthy();
    });

    it('shows the assumptions above the storyline', () => {
      const deck = makeDeck({
        stage: 'storyline',
        slides: [],
        storyline: [{ id: 'l1', text: 'Why now' }],
        assumptions: 'For the leadership team, about ten minutes.',
      });
      render(<DeckWorkspace {...studioProps({ deck })} />);
      expect(screen.getByText('For the leadership team, about ten minutes.', { exact: false })).toBeTruthy();
      expect(screen.getByDisplayValue('Why now')).toBeTruthy();
    });

    it('shows the first-time tips once slides exist and the model is idle', () => {
      const { rerender } = render(<DeckWorkspace {...studioProps({ busyTool: 'add_slide' })} />);
      expect(screen.queryByRole('complementary', { name: 'Tips' })).toBeNull();
      rerender(<DeckWorkspace {...studioProps()} />);
      expect(screen.getByRole('complementary', { name: 'Tips' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
      expect(screen.queryByRole('complementary', { name: 'Tips' })).toBeNull();
    });
  });
});

describe('withoutAssumedLead', () => {
  it('drops a model lead-in that repeats the "Assumed" label', async () => {
    const { withoutAssumedLead } = await import('./DeckWorkspace');
    expect(withoutAssumedLead('Assumed the audience is the eng team.')).toBe('The audience is the eng team.');
    expect(withoutAssumedLead('I assumed this is for leads.')).toBe('This is for leads.');
    expect(withoutAssumedLead('Assumptions: board audience.')).toBe('Board audience.');
    expect(withoutAssumedLead('For eng leads, aiming for approval.')).toBe('For eng leads, aiming for approval.');
  });
});
