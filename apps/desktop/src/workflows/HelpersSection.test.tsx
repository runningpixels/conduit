import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { LibraryAgent, WorkflowDefinition } from '../ipc/contracts';
import { WorkflowEditor, type WorkflowDraft } from './WorkflowEditor';
import {
  detachLibraryHelper,
  helperNames,
  libraryRef,
  newHelper,
  removeHelper,
  toLibraryRef,
  withHelperTokens,
  withLibraryHelper,
  withStepHelper,
} from './editorModel';

const ipc = vi.hoisted(() => ({
  listProviderDescriptors: vi.fn(),
  listConfiguredProviders: vi.fn(),
  listProviderModels: vi.fn(),
  getSettings: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  listDecks: vi.fn(),
  listDrafts: vi.fn(),
  listInstalledConnectors: vi.fn(),
  listLibraryAgents: vi.fn(),
  createLibraryAgent: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

beforeEach(() => {
  localStorage.setItem('conduit:v12-workflow-view', 'list');
  ipc.listProviderDescriptors.mockResolvedValue([]);
  ipc.listConfiguredProviders.mockResolvedValue([]);
  ipc.listProviderModels.mockResolvedValue([]);
  ipc.getSettings.mockResolvedValue({ activeProvider: 'anthropic', activeModel: 'claude-x' });
  ipc.listInstalledConnectors.mockResolvedValue([]);
  ipc.listLibraryAgents.mockResolvedValue([]);
});

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

const base: WorkflowDefinition = { steps: [{ id: 'agent', type: 'agent', prompt: 'Do it', tools: ['web_search'] }] };

describe('a saved helper with settings left out', () => {
  it('opens in the editor', async () => {
    // As drafted and saved: no "tools" or "agents" when it has none.
    const saved = {
      agents: [{ id: 'writer', name: 'Writer', instructions: 'Write it up.' }],
      steps: [{ id: 'agent', type: 'agent', prompt: 'Do it', agents: ['writer'] }],
    } as unknown as WorkflowDefinition;
    renderEditor(saved);
    expect(await screen.findByDisplayValue('Writer')).toBeTruthy();
  });
});

describe('helper model functions', () => {
  it('derives a unique id from the name', () => {
    const a = newHelper([], 'Web Researcher!');
    expect(a.id).toBe('web_researcher');
    expect(newHelper([a], 'Web Researcher!').id).toBe('web_researcher_2');
  });

  it('removing a helper clears it from steps, loops and other helpers', () => {
    const def: WorkflowDefinition = {
      agents: [
        { id: 'a', name: 'A', instructions: '', tools: [], agents: ['b'] },
        { id: 'b', name: 'B', instructions: '', tools: [] },
      ],
      steps: [
        { id: 's', type: 'agent', prompt: '', agents: ['a', 'b'] },
        { id: 'loop', type: 'for_each', items: '', steps: [{ id: 'in', type: 'agent', prompt: '', agents: ['b'] }] },
      ],
    };
    const next = removeHelper(def, 'b');
    expect(next.agents).toEqual([{ id: 'a', name: 'A', instructions: '', tools: [] }]);
    expect(next.steps[0]).toMatchObject({ agents: ['a'] });
    const inner = (next.steps[1] as Extract<(typeof next.steps)[number], { type: 'for_each' }>).steps[0];
    expect('agents' in inner).toBe(false);
    expect(removeHelper(next, 'a').agents).toBeUndefined();
  });

  it('keeps token limits in range and toggles step links', () => {
    const h = newHelper([], 'X');
    expect(withHelperTokens(h, 5).maxTokens).toBe(1000);
    expect(withHelperTokens(h, 9e9).maxTokens).toBe(300000);
    expect('maxTokens' in withHelperTokens({ ...h, maxTokens: 5000 }, null)).toBe(false);
    const step = withStepHelper({ id: 's', type: 'agent', prompt: '' }, 'x', true);
    expect(step).toMatchObject({ agents: ['x'] });
    expect(helperNames({ agents: [h] })).toEqual({ x: 'X' });
  });
});

describe('Helpers section in the editor', () => {
  it('adds, renames and removes a helper, and removal clears the step list', () => {
    const latest = renderEditor(base);
    fireEvent.click(screen.getByRole('button', { name: 'Add a helper' }));
    expect(latest.draft.definition.agents).toHaveLength(1);
    const id = latest.draft.definition.agents![0].id;
    expect(id).toBe('helper');

    fireEvent.change(screen.getByLabelText('Helper 1 name'), { target: { value: 'Researcher' } });
    // The id stays put when the name changes.
    expect(latest.draft.definition.agents![0]).toMatchObject({ id: 'helper', name: 'Researcher' });

    fireEvent.change(screen.getByLabelText('Instructions for Researcher'), { target: { value: 'Find facts' } });
    expect(latest.draft.definition.agents![0].instructions).toBe('Find facts');

    // The agent step offers it.
    const checklist = screen.getAllByRole('group', { name: 'Can hand work to' })[0];
    fireEvent.click(within(checklist).getByRole('checkbox', { name: 'Researcher' }));
    expect(latest.draft.definition.steps[0]).toMatchObject({ agents: ['helper'] });

    fireEvent.click(screen.getByRole('button', { name: 'Remove helper Researcher' }));
    expect(latest.draft.definition.agents).toBeUndefined();
    expect('agents' in latest.draft.definition.steps[0]).toBe(false);
  });

  it('does not let a helper pick itself, and hints when there are no helpers', () => {
    const latest = renderEditor({
      ...base,
      agents: [
        { id: 'a', name: 'Alpha', instructions: '', tools: [] },
        { id: 'b', name: 'Beta', instructions: '', tools: [] },
      ],
    });
    const alpha = document.querySelector('[data-helper-id="a"]') as HTMLElement;
    const links = within(alpha).getByRole('group', { name: 'Can hand work to' });
    expect(within(links).queryByRole('checkbox', { name: 'Alpha' })).toBeNull();
    fireEvent.click(within(links).getByRole('checkbox', { name: 'Beta' }));
    expect(latest.draft.definition.agents![0].agents).toEqual(['b']);
  });

  it('shows a hint in the agent step while there are no helpers', () => {
    renderEditor(base);
    expect(screen.getByText(/No helpers yet/)).toBeTruthy();
  });
});

const stamp = { createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', usedBy: [] };
const researcherLib: LibraryAgent = {
  agent: { id: 'researcher', name: 'Researcher', instructions: 'Find facts', tools: ['web_search', 'computer'], model: { provider: 'p', model: 'glm-flash' } },
  ...stamp,
};
const writerLib: LibraryAgent = {
  agent: { id: 'writer', name: 'Writer', instructions: 'Write it up', tools: [], agents: ['researcher'] },
  ...stamp,
};

describe('library helper model functions', () => {
  it('names a reference after its library agent, and falls back to the id', () => {
    const def = { agents: [libraryRef('researcher'), libraryRef('gone')] };
    expect(helperNames(def, { researcher: 'Researcher' })).toEqual({ researcher: 'Researcher', gone: 'gone' });
    expect(helperNames(def)).toEqual({ researcher: 'researcher', gone: 'gone' });
  });

  it('adds a reference once and stops at the helper limit', () => {
    const empty: WorkflowDefinition = { steps: [] };
    const one = withLibraryHelper(empty, 'researcher');
    expect(one.agents).toEqual([{ id: 'researcher', library: 'researcher' }]);
    expect(withLibraryHelper(one, 'researcher')).toBe(one);
    const full: WorkflowDefinition = {
      steps: [],
      agents: Array.from({ length: 8 }, (_, i) => ({ id: `h${i}`, name: 'H', instructions: 'x', tools: [] })),
    };
    expect(withLibraryHelper(full, 'researcher')).toBe(full);
  });

  it('copies a library agent into the workflow under the same id, bringing the agents it hands to', () => {
    const def: WorkflowDefinition = { steps: [], agents: [libraryRef('writer')] };
    const next = detachLibraryHelper(def, 'writer', writerLib.agent);
    expect(next.agents).toEqual([
      { id: 'writer', name: 'Writer', instructions: 'Write it up', tools: [], agents: ['researcher'] },
      { id: 'researcher', library: 'researcher' },
    ]);
    expect('library' in next.agents![0]).toBe(false);
  });

  it('turns a helper into a reference under its new id everywhere it is named', () => {
    const def: WorkflowDefinition = {
      agents: [
        { id: 'a', name: 'A', instructions: 'x', tools: [], agents: ['b'] },
        { id: 'b', name: 'B', instructions: 'y', tools: [] },
      ],
      steps: [
        { id: 's', type: 'agent', prompt: '', agents: ['b'] },
        { id: 'loop', type: 'for_each', items: '', steps: [{ id: 'in', type: 'agent', prompt: '', agents: ['b', 'a'] }] },
      ],
    };
    const next = toLibraryRef(def, 'b', 'b_2');
    expect(next.agents).toEqual([{ id: 'a', name: 'A', instructions: 'x', tools: [], agents: ['b_2'] }, { id: 'b_2', library: 'b_2' }]);
    expect(next.steps[0]).toMatchObject({ agents: ['b_2'] });
    const inner = (next.steps[1] as Extract<(typeof next.steps)[number], { type: 'for_each' }>).steps[0];
    expect(inner).toMatchObject({ agents: ['b_2', 'a'] });
  });
});

describe('Helpers section with your own agents', () => {
  it('shows a reference as a read-only card and makes a copy here on request', async () => {
    ipc.listLibraryAgents.mockResolvedValue([researcherLib]);
    const latest = renderEditor({ ...base, agents: [libraryRef('researcher')] });
    const card = await waitFor(() => {
      const el = document.querySelector('[data-helper-id="researcher"]') as HTMLElement;
      expect(within(el).getByText('Researcher')).toBeTruthy();
      return el;
    });
    expect(within(card).getByText('From your agents')).toBeTruthy();
    expect(within(card).getByText('glm-flash · Uses your computer · 1 tool')).toBeTruthy();
    // No fields to edit here.
    expect(within(card).queryByRole('textbox')).toBeNull();
    // The step's hand-off list shows the library name.
    expect(screen.getAllByRole('checkbox', { name: 'Researcher' }).length).toBeGreaterThan(0);

    fireEvent.click(within(card).getByRole('button', { name: 'Make a copy of Researcher here' }));
    expect(latest.draft.definition.agents).toEqual([researcherLib.agent]);
    expect(await screen.findByDisplayValue('Find facts')).toBeTruthy();
  });

  it('says so when the agent it refers to no longer exists', async () => {
    ipc.listLibraryAgents.mockResolvedValue([]);
    renderEditor({ ...base, agents: [libraryRef('gone')] });
    expect(await screen.findByText('“gone” is one of your agents, but it no longer exists.')).toBeTruthy();
  });

  it('adds one of your agents from the list, which no longer offers it', async () => {
    ipc.listLibraryAgents.mockResolvedValue([researcherLib, writerLib]);
    const latest = renderEditor(base);
    const pick = await screen.findByRole('combobox', { name: 'Add from your agents' });
    fireEvent.change(pick, { target: { value: 'writer' } });
    expect(latest.draft.definition.agents).toEqual([{ id: 'writer', library: 'writer' }]);
    const after = screen.getByRole('combobox', { name: 'Add from your agents' });
    expect(within(after).queryByRole('option', { name: 'Writer' })).toBeNull();
    expect(within(after).getByRole('option', { name: 'Researcher' })).toBeTruthy();
  });

  it('offers no list while you have no agents', async () => {
    renderEditor(base);
    await screen.findByRole('button', { name: 'Add a helper' });
    expect(screen.queryByRole('combobox', { name: 'Add from your agents' })).toBeNull();
  });

  it('saves a helper to your agents and replaces it with a reference under the saved id', async () => {
    ipc.listLibraryAgents.mockResolvedValue([]);
    ipc.createLibraryAgent.mockImplementation(async (agent) => ({ ...stamp, agent: { ...agent, id: 'helper_2' } }));
    const latest = renderEditor({
      agents: [{ id: 'helper', name: 'Helper', instructions: 'Do it', tools: ['calculator'], agents: ['other'] }, libraryRef('other')],
      steps: [{ id: 'agent', type: 'agent', prompt: 'Go', agents: ['helper'] }],
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save Helper to your agents' }));
    await waitFor(() => expect(ipc.createLibraryAgent).toHaveBeenCalled());
    // Its hand-off is one of your agents, so it goes along; the library picks the id.
    expect(ipc.createLibraryAgent).toHaveBeenCalledWith({ id: 'helper', name: 'Helper', instructions: 'Do it', tools: ['calculator'], agents: ['other'] });
    await waitFor(() => expect(latest.draft.definition.agents![0]).toEqual({ id: 'helper_2', library: 'helper_2' }));
    expect(latest.draft.definition.steps[0]).toMatchObject({ agents: ['helper_2'] });
  });

  it('drops hand-offs to inline helpers when saving, and shows a refusal', async () => {
    ipc.listLibraryAgents.mockResolvedValue([]);
    ipc.createLibraryAgent.mockRejectedValue(new Error('Too many helpers.'));
    renderEditor({
      agents: [
        { id: 'a', name: 'Alpha', instructions: 'x', tools: [], agents: ['b'] },
        { id: 'b', name: 'Beta', instructions: 'y', tools: [] },
      ],
      steps: base.steps,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save Alpha to your agents' }));
    await waitFor(() => expect(ipc.createLibraryAgent).toHaveBeenCalled());
    expect(ipc.createLibraryAgent).toHaveBeenCalledWith({ id: 'a', name: 'Alpha', instructions: 'x', tools: [] });
    expect(await screen.findByText('Couldn’t save it to your agents: Too many helpers.')).toBeTruthy();
  });
});
