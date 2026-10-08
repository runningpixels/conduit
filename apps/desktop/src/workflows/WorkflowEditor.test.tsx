import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowDefinition, WorkflowStep } from '../ipc/contracts';
import type { DeckSummary, DraftSummary } from '../ipc/contracts';
import { WorkflowEditor, type WorkflowDraft } from './WorkflowEditor';

const ipc = vi.hoisted(() => ({
  listProviderDescriptors: vi.fn(),
  listConfiguredProviders: vi.fn(),
  listProviderModels: vi.fn(),
  getSettings: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  listDecks: vi.fn(),
  listDrafts: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const descriptor = (id: string, displayName: string, tier: number) => ({
  id,
  displayName,
  defaultBaseUrl: null,
  credentialMode: 'required',
  isLocal: false,
  showBaseUrlField: false,
  tier,
  description: null,
});

beforeEach(() => {
  ipc.listProviderDescriptors.mockResolvedValue([
    descriptor('openrouter', 'OpenRouter', 1),
    descriptor('anthropic', 'Anthropic', 1),
    descriptor('gone', 'Gone Cloud', 2),
  ]);
  // `gone` has no key any more.
  ipc.listConfiguredProviders.mockResolvedValue(['openrouter', 'anthropic']);
  ipc.listProviderModels.mockImplementation(async (id: string) =>
    id === 'openrouter' ? [{ id: 'glm-flash' }, { id: 'deepseek-flash' }] : [],
  );
  ipc.getSettings.mockResolvedValue({ activeProvider: 'anthropic', activeModel: 'claude-x' });
});

/// Renders the editor with real state, and exposes the latest draft.
function renderEditor(definition: WorkflowDefinition) {
  const latest: { draft: WorkflowDraft } = { draft: { name: 'Test', description: '', definition } };
  function Harness() {
    const [draft, setDraft] = useState<WorkflowDraft>(latest.draft);
    latest.draft = draft;
    return <WorkflowEditor draft={draft} onChange={setDraft} />;
  }
  render(<Harness />);
  return latest;
}

const card = (name: RegExp) => screen.getByRole('listitem', { name }) as HTMLElement;

/// Type into a chip field (a contenteditable box): replace its text and fire
/// the input event the browser would.
function typeInto(field: HTMLElement, text: string) {
  field.textContent = text;
  fireEvent.input(field);
}


describe('WorkflowEditor', () => {
  it('builds fetch → ask the model → save, inserting values at the cursor', () => {
    const out = renderEditor({ inputs: [], steps: [] });

    // An input asked each run.
    fireEvent.click(screen.getByRole('button', { name: 'Add a value' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of value 1' }), { target: { value: 'Site' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Default for value 1' }), { target: { value: 'https://example.com' } });

    // Fetch the site.
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'fetch_page' } });
    const fetchCard = card(/^1\. Fetch pages/);
    fireEvent.change(within(fetchCard).getByRole('combobox', { name: 'Insert a value into Page 1' }), {
      target: { value: 'inputs.value' },
    });

    // Ask the model about it; the value goes where the cursor is.
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'summarize' } });
    const askCard = card(/^2\. Ask the model/);
    typeInto(within(askCard).getByRole('textbox', { name: 'Instruction' }), 'Summarize this');
    const input = within(askCard).getByRole('textbox', { name: 'Text to work on' });
    typeInto(input, 'Page: ');
    const caret = document.createRange();
    caret.setStart(input.firstChild!, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(caret);
    fireEvent.keyUp(input);
    const insert = within(askCard).getByRole('combobox', { name: 'Insert a value into Text to work on' });
    // Only earlier steps are offered.
    const offered = within(insert).getAllByRole('option').map((o) => o.textContent);
    expect(offered).toEqual(expect.arrayContaining(['Site', "today's date", 'fetch · text', 'fetch · pages']));
    expect(offered.some((label) => label?.startsWith('summary'))).toBe(false);
    fireEvent.change(insert, { target: { value: 'steps.fetch.text' } });

    // Save the answer.
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'save_artifact' } });
    const saveCard = card(/^3\. Save a document/);
    typeInto(within(saveCard).getByRole('textbox', { name: 'Title' }), 'Summary');
    fireEvent.change(within(saveCard).getByRole('combobox', { name: 'Insert a value into Content' }), {
      target: { value: 'steps.summary.text' },
    });
    fireEvent.change(within(saveCard).getByRole('combobox', { name: 'Each run' }), { target: { value: 'create' } });

    expect(out.draft.definition).toEqual({
      inputs: [{ id: 'value', label: 'Site', default: 'https://example.com' }],
      steps: [
        { id: 'fetch', type: 'fetch_page', urls: ['{{inputs.value}}'] },
        { id: 'summary', type: 'summarize', prompt: 'Summarize this', input: 'Page: {{steps.fetch.text}}' },
        { id: 'save', type: 'save_artifact', title: 'Summary', content: '{{steps.summary.text}}', format: 'markdown', mode: 'create' },
      ],
    });
    // The inserted values show as chips with readable labels.
    expect(within(askCard).getByRole('textbox', { name: 'Text to work on' })).toHaveTextContent('Page: fetch · text×');
  });

  it('repeats steps for each item, offering the item fields inside', () => {
    const out = renderEditor({
      steps: [{ id: 'fetch', type: 'fetch_page', urls: ['https://example.com'] }],
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'for_each' } });
    const loop = card(/^2\. Repeat for each/);
    fireEvent.change(within(loop).getByRole('combobox', { name: 'Repeat for each of' }), {
      target: { value: 'steps.fetch.pages' },
    });
    fireEvent.change(within(loop).getByRole('combobox', { name: 'Add a step to repeat…' }), { target: { value: 'template' } });
    const inner = within(loop).getByRole('listitem', { name: /^1\. Write text/ });
    const options = within(within(inner).getByRole('combobox', { name: 'Insert a value into Text' }))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['title', 'text', 'address', 'position in the list']));
    fireEvent.change(within(inner).getByRole('combobox', { name: 'Insert a value into Text' }), {
      target: { value: 'item.title' },
    });
    const loopStep = out.draft.definition.steps[1] as Extract<WorkflowStep, { type: 'for_each' }>;
    expect(loopStep).toMatchObject({ id: 'each', items: 'steps.fetch.pages' });
    expect(loopStep.steps).toEqual([{ id: 'text', type: 'template', template: '{{item.title}}' }]);
  });

  it('moves, removes and marks steps to keep going', () => {
    const out = renderEditor({
      steps: [
        { id: 'a', type: 'template', template: 'A' },
        { id: 'b', type: 'template', template: 'B' },
        { id: 'c', type: 'template', template: 'C' },
      ],
    });
    expect(screen.getByRole('button', { name: 'Move step 1 (Write text) up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move step 1 (Write text) down' }));
    expect(out.draft.definition.steps.map((s) => s.id)).toEqual(['b', 'a', 'c']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove step 3 (Write text)' }));
    expect(out.draft.definition.steps.map((s) => s.id)).toEqual(['b', 'a']);
    fireEvent.click(within(card(/^2\. Write text/)).getByRole('checkbox', { name: 'Keep going if this step fails' }));
    expect(out.draft.definition.steps[1]).toMatchObject({ id: 'a', onError: 'skip' });
  });

  it('sets how often a step tries again, writing only a change from the usual', () => {
    const out = renderEditor({
      inputs: [],
      steps: [{ id: 'fetch', type: 'fetch_page', urls: ['https://example.com'] }],
    });
    const retries = within(card(/^1\. Fetch pages/)).getByRole('combobox', { name: 'If it fails, try again' });
    expect(retries).toHaveValue('2');
    expect(within(retries).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'No',
      'Once',
      '2 times',
      '3 times',
      '4 times',
      '5 times',
    ]);
    fireEvent.change(retries, { target: { value: '0' } });
    expect(out.draft.definition.steps[0].retries).toBe(0);
    fireEvent.change(retries, { target: { value: '2' } });
    expect(out.draft.definition.steps[0].retries).toBeUndefined();
  });

  it('adds a notification step with its title and message, and no retry choice', () => {
    const out = renderEditor({ inputs: [], steps: [] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'notify' } });
    const notify = card(/^1\. Show a notification/);
    typeInto(within(notify).getByRole('textbox', { name: 'Title' }), 'Briefing ready');
    typeInto(within(notify).getByRole('textbox', { name: 'Message' }), 'Have a look');
    expect(out.draft.definition.steps[0]).toEqual({
      id: 'notify',
      type: 'notify',
      title: 'Briefing ready',
      body: 'Have a look',
    });
    expect(within(notify).queryByRole('combobox', { name: 'If it fails, try again' })).not.toBeInTheDocument();
  });

  it('adds an ask step with choices and an answer for when nobody answers', () => {
    const out = renderEditor({ inputs: [], steps: [] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'ask' } });
    const ask = card(/^1\. Ask me/);
    typeInto(within(ask).getByRole('textbox', { name: 'Question' }), 'Which topic?');
    const choices = within(ask).getByRole('textbox', { name: /^Answers to pick from/ });
    fireEvent.change(choices, { target: { value: 'Rust\n Go \n\n' } });
    fireEvent.blur(choices);
    fireEvent.change(within(ask).getByRole('textbox', { name: 'If nobody answers, use' }), { target: { value: 'Rust' } });
    expect(out.draft.definition.steps[0]).toEqual({
      id: 'ask',
      type: 'ask',
      question: 'Which topic?',
      choices: ['Rust', 'Go'],
      default: 'Rust',
    });
    // Later steps can insert the answer.
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'template' } });
    const insert = within(card(/^2\. /)).getByRole('combobox', { name: /^Insert a value into/ });
    expect(within(insert).getAllByRole('option').map((o) => o.textContent)).toContain('ask · answer');
  });

  it('adds an agent step and picks its tools, kept in a stable order', () => {
    const out = renderEditor({ inputs: [], steps: [] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'agent' } });
    const agent = card(/^1\. Let the model use tools/);
    typeInto(within(agent).getByRole('textbox', { name: 'Instruction' }), 'Find the release notes');
    const tools = within(agent).getByRole('group', { name: 'Tools it may use' });
    expect(within(tools).getByRole('checkbox', { name: 'search the web' })).toBeChecked();
    expect(within(tools).getByRole('checkbox', { name: 'read any web page it chooses' })).toBeChecked();
    fireEvent.click(within(tools).getByRole('checkbox', { name: 'search the web' }));
    fireEvent.click(within(tools).getByRole('checkbox', { name: 'do arithmetic' }));
    fireEvent.click(within(tools).getByRole('checkbox', { name: 'search the web' }));
    expect(out.draft.definition.steps[0]).toMatchObject({
      type: 'agent',
      prompt: 'Find the release notes',
      tools: ['web_search', 'web_fetch', 'calculator'],
    });
  });

  it('keeps a summarize schema it cannot edit', () => {
    const schema = { type: 'object' };
    const out = renderEditor({ steps: [{ id: 's', type: 'summarize', prompt: 'p', input: 'i', schema }] });
    expect(screen.getByText(/Change the shape of that data in the JSON view/)).toBeInTheDocument();
    typeInto(screen.getByRole('textbox', { name: 'Instruction' }), 'new prompt');
    expect(out.draft.definition.steps[0]).toMatchObject({ prompt: 'new prompt', schema });
  });

  describe('models', () => {
    it('writes the workflow default only when a provider and model are chosen, and clears it', async () => {
      const out = renderEditor({ steps: [] });
      const picker = await screen.findByRole('combobox', { name: 'Model provider' });
      await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));
      // Only configured providers are offered.
      const offered = within(picker).getAllByRole('option').map((o) => o.textContent);
      expect(offered).toEqual(['Follow the chat model', 'Anthropic', 'OpenRouter']);
      expect('model' in out.draft.definition).toBe(false);

      fireEvent.change(picker, { target: { value: 'openrouter' } });
      await waitFor(() => expect(out.draft.definition.model).toEqual({ provider: 'openrouter', model: 'glm-flash' }));
      fireEvent.change(await screen.findByRole('combobox', { name: 'Model model' }), { target: { value: 'deepseek-flash' } });
      expect(out.draft.definition.model).toEqual({ provider: 'openrouter', model: 'deepseek-flash' });

      fireEvent.click(screen.getByRole('button', { name: 'Use default' }));
      expect('model' in out.draft.definition).toBe(false);
    });

    it("offers a step's own model on summarize and agent steps only", async () => {
      const out = renderEditor({
        steps: [
          { id: 's', type: 'summarize', prompt: 'p', input: 'i' },
          { id: 'a', type: 'agent', prompt: 'p' },
          { id: 'n', type: 'notify', title: 't' },
        ],
      });
      const name = 'Model for this step provider';
      const picker = within(card(/^1\./)).getByRole('combobox', { name });
      await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));
      expect(within(card(/^2\./)).getByRole('combobox', { name })).toBeInTheDocument();
      expect(within(card(/^3\./)).queryByRole('combobox', { name })).toBeNull();

      expect(within(picker).getAllByRole('option')[0]).toHaveTextContent("Use the workflow's model");
      fireEvent.change(picker, { target: { value: 'openrouter' } });
      await waitFor(() =>
        expect(out.draft.definition.steps[0]).toMatchObject({ model: { provider: 'openrouter', model: 'glm-flash' } }),
      );
      expect('model' in out.draft.definition.steps[1]).toBe(false);
      expect('model' in out.draft.definition).toBe(false);

      fireEvent.click(within(card(/^1\./)).getByRole('button', { name: 'Use default' }));
      expect('model' in out.draft.definition.steps[0]).toBe(false);
    });

    it("keeps a saved choice whose provider isn't set up, and says so", async () => {
      renderEditor({ model: { provider: 'gone', model: 'old-model' }, steps: [] });
      expect(await screen.findByText("old-model — Gone Cloud isn't set up")).toBeInTheDocument();
    });
  });
});

describe('WorkflowEditor: only if something changed', () => {
  it('adds a condition, shows its text field only when needed, and writes the JSON', () => {
    const out = renderEditor({ steps: [{ id: 'fetch', type: 'fetch_page', urls: ['https://example.com'] }] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'condition' } });
    const check = card(/^2\. Continue only if…/);
    expect(out.draft.definition.steps[1]).toEqual({ id: 'check', type: 'condition', value: '', is: 'changed' });
    expect(within(check).queryByRole('textbox', { name: 'Text' })).toBeNull();

    fireEvent.change(within(check).getByRole('combobox', { name: 'Insert a value into Value to check' }), {
      target: { value: 'steps.fetch.text' },
    });
    fireEvent.change(within(check).getByRole('combobox', { name: 'Continue only if it' }), { target: { value: 'contains' } });
    typeInto(within(check).getByRole('textbox', { name: 'Text' }), 'release');
    expect(out.draft.definition.steps[1]).toEqual({
      id: 'check',
      type: 'condition',
      value: '{{steps.fetch.text}}',
      is: 'contains',
      text: 'release',
    });

    fireEvent.change(within(check).getByRole('combobox', { name: 'Continue only if it' }), { target: { value: 'empty' } });
    expect(within(check).queryByRole('textbox', { name: 'Text' })).toBeNull();
    expect(out.draft.definition.steps[1]).not.toHaveProperty('text');
  });

  it('does not offer a condition inside a loop', () => {
    renderEditor({ steps: [{ id: 'each', type: 'for_each', items: '', steps: [] }] });
    const inside = screen.getByRole('combobox', { name: 'Add a step to repeat…' });
    expect(within(inside).queryByRole('option', { name: 'Continue only if…' })).toBeNull();
    const top = screen.getByRole('combobox', { name: 'Add a step…' });
    expect(within(top).getByRole('option', { name: 'Continue only if…' })).toBeInTheDocument();
  });

  it('toggles "only if it changed" on notify and save, at the top level only', () => {
    const out = renderEditor({
      steps: [
        { id: 'notify', type: 'notify', title: 'Hi' },
        { id: 'save', type: 'save_artifact', title: 'T', content: 'c' },
        { id: 'each', type: 'for_each', items: '', steps: [{ id: 'inner', type: 'notify', title: 'In' }] },
      ],
    });
    // The loop's own first step has the same name; the outer card comes first.
    const outerNotify = () => screen.getAllByRole('listitem', { name: /^1\. Show a notification/ })[0] as HTMLElement;
    const box = (c: HTMLElement) => within(c).getByRole('checkbox', { name: 'Only if it changed since the last run' });
    fireEvent.click(box(outerNotify()));
    fireEvent.click(box(card(/^2\. Save a document/)));
    expect(out.draft.definition.steps[0]).toMatchObject({ onlyIfChanged: true });
    expect(out.draft.definition.steps[1]).toMatchObject({ onlyIfChanged: true });
    fireEvent.click(box(outerNotify()));
    expect(out.draft.definition.steps[0]).not.toHaveProperty('onlyIfChanged');
    const inner = screen.getAllByRole('listitem', { name: /^1\. Show a notification/ })[1];
    expect(within(inner).queryByRole('checkbox', { name: 'Only if it changed since the last run' })).toBeNull();
  });
});

describe('data steps and folder', () => {
  it('sets and clears the folder with the picker', async () => {
    const out = renderEditor({ steps: [] });
    ipc.pickWorkspaceFolder.mockResolvedValueOnce('C:\\Reports');
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await waitFor(() => expect(out.draft.definition.folder).toBe('C:\\Reports'));
    expect(screen.getByText('C:\\Reports')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear folder' }));
    expect(out.draft.definition).not.toHaveProperty('folder');
    // Cancelling the dialog changes nothing.
    ipc.pickWorkspaceFolder.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    await waitFor(() => expect(ipc.pickWorkspaceFolder).toHaveBeenCalledTimes(2));
    expect(out.draft.definition).not.toHaveProperty('folder');
  });

  it('writes a read_file path and hints when there is no folder', () => {
    const out = renderEditor({ steps: [] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'read_file' } });
    const c = card(/^1\. Read a file/);
    expect(within(c).getByText(/Choose the workflow's folder above/)).toBeTruthy();
    typeInto(within(c).getByRole('textbox', { name: 'File path (inside the folder)' }), 'reports/metrics.csv');
    expect(out.draft.definition.steps[0]).toEqual({ id: 'file', type: 'read_file', path: 'reports/metrics.csv' });
  });

  it('writes a parse_data input and format, and offers the file text to insert', () => {
    const out = renderEditor({
      folder: 'C:\\Reports',
      steps: [{ id: 'file', type: 'read_file', path: 'a.csv' }],
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'parse_data' } });
    const c = card(/^2\. Turn text into a table/);
    fireEvent.change(within(c).getByRole('combobox', { name: 'Insert a value into Text to turn into a table' }), {
      target: { value: 'steps.file.text' },
    });
    fireEvent.change(within(c).getByRole('combobox', { name: 'Format' }), { target: { value: 'tsv' } });
    expect(out.draft.definition.steps[1]).toEqual({ id: 'data', type: 'parse_data', input: '{{steps.file.text}}', format: 'tsv' });
    expect(screen.queryByText(/Choose the workflow's folder above/)).toBeNull();
  });
});

const deckSummary = (id: string, title: string, stage: DeckSummary['stage'], slideCount: number): DeckSummary => ({
  id,
  title,
  themeName: 'Plain',
  slideCount,
  stage,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
});
const draftSummary = (id: string, title: string, stage: DraftSummary['stage'], words: number): DraftSummary => ({
  id,
  title,
  stage,
  words,
  updatedAt: '2026-10-01T00:00:00Z',
});

describe('update a deck or draft', () => {
  beforeEach(() => {
    ipc.listDecks.mockResolvedValue([
      deckSummary('deck-1', 'Q3 numbers', 'slides', 12),
      deckSummary('deck-2', 'Kickoff', 'slides', 1),
      deckSummary('deck-3', 'Still an outline', 'storyline', 0),
    ]);
    ipc.listDrafts.mockResolvedValue([
      draftSummary('draft-1', 'Monthly report', 'draft', 1200),
      draftSummary('draft-2', 'Outline only', 'outline', 0),
    ]);
  });

  it('adds a deck step, picks from slides-stage decks only, and writes instructions, input and model', async () => {
    const out = renderEditor({
      inputs: [],
      steps: [{ id: 'data', type: 'parse_data', input: '', format: 'csv' }],
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'edit_deck' } });
    const deck = card(/^2\. Update a deck/);
    const picker = (await within(deck).findByRole('combobox', { name: 'Deck' })) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1));
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a deck…',
      'Q3 numbers · 12 slides',
      'Kickoff · 1 slide',
    ]);
    // Nothing is chosen yet, and the card says so.
    expect(within(deck).getByText('Choose the deck this step updates.')).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'deck-1' } });
    expect(within(deck).queryByText('Choose the deck this step updates.')).not.toBeInTheDocument();
    typeInto(within(deck).getByRole('textbox', { name: 'What to change' }), "Update slide 3's chart.");
    fireEvent.change(within(deck).getByRole('combobox', { name: 'Insert a value into Text to work on' }), {
      target: { value: 'steps.data.text' },
    });
    expect(out.draft.definition.steps[1]).toMatchObject({
      type: 'edit_deck',
      deck: 'deck-1',
      instructions: "Update slide 3's chart.",
      input: '{{steps.data.text}}',
    });
    // The model row is the same one the summarize step has.
    expect(within(deck).getByText('Model for this step')).toBeInTheDocument();
  });

  it('offers drafts past their outline, with their size', async () => {
    const out = renderEditor({ inputs: [], steps: [] });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'edit_draft' } });
    const draft = card(/^1\. Update a draft/);
    const picker = (await within(draft).findByRole('combobox', { name: 'Draft' })) as HTMLSelectElement;
    await waitFor(() => expect(within(picker).getAllByRole('option').length).toBeGreaterThan(1));
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Choose a draft…',
      'Monthly report · 1,200 words',
    ]);
    fireEvent.change(picker, { target: { value: 'draft-1' } });
    typeInto(within(draft).getByRole('textbox', { name: 'What to change' }), "Add a section 'This week'.");
    expect(out.draft.definition.steps[0]).toMatchObject({
      type: 'edit_draft',
      draft: 'draft-1',
      instructions: "Add a section 'This week'.",
    });
    expect('input' in out.draft.definition.steps[0]).toBe(false);
  });

  it('says so in the card when the deck or draft was deleted', async () => {
    renderEditor({
      inputs: [],
      steps: [
        { id: 'a', type: 'edit_deck', deck: 'gone', instructions: 'x' },
        { id: 'b', type: 'edit_draft', draft: 'gone-too', instructions: 'y' },
      ],
    });
    expect(await screen.findByText('This deck was deleted')).toBeInTheDocument();
    expect(await screen.findByText('This draft was deleted')).toBeInTheDocument();
  });

  it('flags a deck that is still an outline', async () => {
    renderEditor({ inputs: [], steps: [{ id: 'a', type: 'edit_deck', deck: 'deck-3', instructions: 'x' }] });
    expect(await screen.findByText('This deck is still an outline. Finish it in Slides first.')).toBeInTheDocument();
  });

  it('does not offer them inside a loop', () => {
    renderEditor({ inputs: [], steps: [{ id: 'each', type: 'for_each', items: '', steps: [] }] });
    const inner = screen.getByRole('combobox', { name: 'Add a step to repeat…' });
    expect(within(inner).queryByRole('option', { name: 'Update a deck' })).not.toBeInTheDocument();
    expect(within(inner).queryByRole('option', { name: 'Update a draft' })).not.toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: 'Add a step…' })).getByRole('option', { name: 'Update a deck' })).toBeInTheDocument();
  });
});
