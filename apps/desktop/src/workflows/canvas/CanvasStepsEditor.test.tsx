import { useState } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkflowDefinition } from '../../ipc/contracts';
import { STARTER_WORKFLOWS } from '../starters';
import { WorkflowEditor, type WorkflowDraft } from '../WorkflowEditor';
import { installReactFlowStubs } from '../../test/reactFlowStubs';

const ipc = vi.hoisted(() => ({
  getSettings: vi.fn(),
  listProviderModels: vi.fn(),
  listDecks: vi.fn(),
  listDrafts: vi.fn(),
  listKnowledgeCollections: vi.fn(),
  listConnectors: vi.fn(),
  listWorkflowConnectorTools: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
}));
vi.mock('../../ipc/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../ipc/client')>()), ...ipc }));

beforeAll(installReactFlowStubs);
beforeEach(() => {
  localStorage.setItem('conduit:v12-workflow-view', 'canvas');
  for (const fn of Object.values(ipc)) fn.mockReset();
  ipc.getSettings.mockResolvedValue({ activeProvider: 'anthropic', activeModel: 'claude-x' });
  ipc.listProviderModels.mockResolvedValue([]);
  ipc.listDecks.mockResolvedValue([]);
  ipc.listDrafts.mockResolvedValue([]);
  ipc.listKnowledgeCollections.mockResolvedValue([]);
  ipc.listConnectors.mockResolvedValue([]);
});

const briefing = STARTER_WORKFLOWS.find((s) => s.id === 'briefing')!.definition as WorkflowDefinition;
const ids = (def: WorkflowDefinition) => def.steps.map((s) => (s.type === 'for_each' ? `${s.id}[${s.steps.map((c) => c.id).join(',')}]` : s.id));

function renderEditor(definition: WorkflowDefinition, problems?: string[]) {
  const latest: { draft: WorkflowDraft } = { draft: { name: 'Test', description: '', definition } };
  function Harness() {
    const [draft, setDraft] = useState<WorkflowDraft>(latest.draft);
    latest.draft = draft;
    return <WorkflowEditor draft={draft} onChange={setDraft} problems={problems} />;
  }
  render(<Harness />);
  return latest;
}

const node = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
const openMenu = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Add a step' }));
  return screen.getByRole('menu', { name: 'Add a step' });
};
const panel = () => screen.getByRole('complementary', { name: 'Step details' });

describe('editing on the canvas', () => {
  it('opens on the canvas when that was the choice, and switches to the list', () => {
    renderEditor(briefing);
    expect(screen.getByRole('button', { name: 'Canvas' })).toHaveAttribute('aria-pressed', 'true');
    expect(node('pick')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(document.querySelector('.react-flow')).toBeNull();
    expect(localStorage.getItem('conduit:v12-workflow-view')).toBe('list');
  });

  it('shows the Start panel until a step is selected, and switches back from the start node', () => {
    renderEditor(briefing);
    expect(within(panel()).getByRole('heading', { name: 'Start' })).toBeTruthy();
    expect(within(panel()).getByRole('group', { name: 'Starts when' })).toBeTruthy();
    fireEvent.click(node('pick'));
    expect(within(panel()).queryByRole('heading', { name: 'Start' })).toBeNull();
    expect(within(panel()).getByText('Step 2 · Ask the model')).toBeTruthy();
    expect(within(panel()).getByRole('button', { name: 'Delete step' })).toBeTruthy();
    fireEvent.click(node('__start'));
    expect(within(panel()).getByRole('heading', { name: 'Start' })).toBeTruthy();
    fireEvent.click(node('pick'));
    fireEvent.click(document.querySelector('.react-flow__pane') as HTMLElement);
    expect(within(panel()).getByRole('heading', { name: 'Start' })).toBeTruthy();
  });

  it('groups the steps in the Add a step menu, each kind once', () => {
    renderEditor(briefing);
    const menu = openMenu();
    const groups = within(menu).getAllByRole('group').map((g) => [g.getAttribute('aria-label'), within(g).getAllByRole('menuitem').map((i) => i.textContent)]);
    expect(groups.map(([name]) => name)).toEqual(['Get information', 'Work with the model', 'Save and tell me', 'Control the flow']);
    const all = groups.flatMap(([, items]) => items as string[]);
    expect(all).toHaveLength(19);
    expect(new Set(all).size).toBe(19);
    expect(groups[3][1]).toEqual(['Repeat for each', 'Continue only if…', 'Ask me']);
    expect(within(menu).getByText('Add at the end')).toBeTruthy();
  });

  it('closes the menu with Escape (focus back on the button) and on an outside click', () => {
    renderEditor(briefing);
    const button = screen.getByRole('button', { name: 'Add a step' });
    const menu = openMenu();
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
    openMenu();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('adds a step after the selected one, selects it, and shows its form', () => {
    const out = renderEditor(briefing);
    fireEvent.click(node('pick'));
    const menu = openMenu();
    expect(within(menu).getByText(/^Add after /)).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Write text' }));
    expect(screen.queryByRole('menu')).toBeNull();
    const added = out.draft.definition.steps[2];
    expect(added.type).toBe('template');
    expect(ids(out.draft.definition)).toEqual(['fetch', 'pick', added.id, 'read[article,gist,card]', 'write', 'save']);
    // The new step is selected, with its form beside the canvas.
    expect(within(panel()).getByText('Step 3 · Write text')).toBeTruthy();
    expect(within(panel()).getByRole('region', { name: 'Write text' })).toBeTruthy();
  });

  it('offers only what a loop can hold inside a selected loop, and adds there', () => {
    const out = renderEditor(briefing);
    fireEvent.click(node('read'));
    const menu = openMenu();
    expect(within(menu).getByText('Add inside the loop')).toBeTruthy();
    expect(within(menu).queryByRole('menuitem', { name: 'Continue only if…' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Research a topic' })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Show a notification' }));
    const loop = out.draft.definition.steps[2];
    expect(loop.type === 'for_each' && loop.steps.map((s) => s.type)).toEqual(['fetch_page', 'summarize', 'template', 'notify']);
  });

  it('edits the selected step with the same form as the list, without the loop list inside', () => {
    const out = renderEditor(briefing);
    fireEvent.click(node('read'));
    expect(within(panel()).getByText('Repeat for each of')).toBeTruthy();
    expect(panel().querySelector('.wf-nested')).toBeNull();
    // Its Delete button removes the loop and what is in it.
    fireEvent.click(within(panel()).getByRole('button', { name: 'Delete step' }));
    expect(ids(out.draft.definition)).toEqual(['fetch', 'pick', 'write', 'save']);
    expect(within(panel()).getByRole('heading', { name: 'Start' })).toBeTruthy();
  });

  it('keeps the failure settings collapsed, saying what happens now', () => {
    renderEditor(briefing);
    fireEvent.click(node('fetch'));
    const details = panel().querySelector('details.wfe-failure') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText('try again 2 times, then stop')).toBeTruthy();
  });

  it('marks the steps the checker names', () => {
    renderEditor(briefing, ['Step "write": the instruction is empty.']);
    expect(node('write').querySelector('.has-problem')).not.toBeNull();
  });
});
