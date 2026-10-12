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
const palette = () => screen.getByRole('group', { name: 'Add a step' });

describe('editing on the canvas', () => {
  it('opens on the canvas when that was the choice, and switches to the list', () => {
    renderEditor(briefing);
    expect(screen.getByRole('button', { name: 'Canvas' })).toHaveAttribute('aria-pressed', 'true');
    expect(node('pick')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'List' }));
    expect(document.querySelector('.react-flow')).toBeNull();
    expect(localStorage.getItem('conduit:v12-workflow-view')).toBe('list');
  });

  it('adds a step after the selected one, selects it, and shows its form', () => {
    const out = renderEditor(briefing);
    expect(within(palette()).getByText('Add at the end')).toBeTruthy();
    fireEvent.click(node('pick'));
    expect(within(palette()).getByText('Add after pick')).toBeTruthy();
    fireEvent.click(within(palette()).getByRole('button', { name: 'Write text' }));
    const added = out.draft.definition.steps[2];
    expect(added.type).toBe('template');
    expect(ids(out.draft.definition)).toEqual(['fetch', 'pick', added.id, 'read[article,gist,card]', 'write', 'save']);
    // The new step is selected, with its form beside the canvas.
    const inspector = screen.getByRole('complementary', { name: 'Step details' });
    expect(within(inspector).getByRole('listitem', { name: /Write text/ })).toBeTruthy();
  });

  it('offers only what a loop can hold inside a selected loop, and adds there', () => {
    const out = renderEditor(briefing);
    fireEvent.click(node('read'));
    expect(within(palette()).getByText('Add inside the loop')).toBeTruthy();
    expect(within(palette()).queryByRole('button', { name: 'Continue only if…' })).toBeNull();
    fireEvent.click(within(palette()).getByRole('button', { name: 'Show a notification' }));
    const loop = out.draft.definition.steps[2];
    expect(loop.type === 'for_each' && loop.steps.map((s) => s.type)).toEqual(['fetch_page', 'summarize', 'template', 'notify']);
  });

  it('edits the selected step with the same form as the list, without the loop list inside', () => {
    const out = renderEditor(briefing);
    fireEvent.click(node('read'));
    const inspector = screen.getByRole('complementary', { name: 'Step details' });
    expect(within(inspector).getByText('Repeat for each of')).toBeTruthy();
    expect(inspector.querySelector('.wf-nested')).toBeNull();
    // Its remove button deletes the loop and what is in it.
    fireEvent.click(within(inspector).getByRole('button', { name: /^Remove step 3/ }));
    expect(ids(out.draft.definition)).toEqual(['fetch', 'pick', 'write', 'save']);
  });

  it('marks the steps the checker names', () => {
    renderEditor(briefing, ['Step "write": the instruction is empty.']);
    expect(node('write').querySelector('.has-problem')).not.toBeNull();
  });
});
