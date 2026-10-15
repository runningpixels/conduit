import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkflowDefinition } from '../ipc/contracts';
import { WorkflowEditor, type WorkflowDraft } from './WorkflowEditor';
import { helperNames, newHelper, removeHelper, withHelperTokens, withStepHelper } from './editorModel';

const ipc = vi.hoisted(() => ({
  listProviderDescriptors: vi.fn(),
  listConfiguredProviders: vi.fn(),
  listProviderModels: vi.fn(),
  getSettings: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  listDecks: vi.fn(),
  listDrafts: vi.fn(),
  listInstalledConnectors: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

beforeEach(() => {
  localStorage.setItem('conduit:v12-workflow-view', 'list');
  ipc.listProviderDescriptors.mockResolvedValue([]);
  ipc.listConfiguredProviders.mockResolvedValue([]);
  ipc.listProviderModels.mockResolvedValue([]);
  ipc.getSettings.mockResolvedValue({ activeProvider: 'anthropic', activeModel: 'claude-x' });
  ipc.listInstalledConnectors.mockResolvedValue([]);
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
