import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowDefinition, WorkflowStep } from '../ipc/contracts';
import { WorkflowEditor, type WorkflowDraft } from './WorkflowEditor';
import { describeStep, computerText } from './describeStep';
import { permissionText, reviewText, agentToolsText } from './permissionText';
import { usesComputer, withComputer, withComputerTool, withFolder } from './editorModel';
import { EN_MESSAGES } from '../i18n';

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

const t = (key: string, params?: Record<string, unknown>) =>
  (EN_MESSAGES[key] ?? key).replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

const COMPUTER_LABEL = /Use the computer/;

describe('model helpers', () => {
  it('keeps computer in tools without treating it as a connector tool', () => {
    expect(withComputerTool(['web_search', 'gh/list'], true)).toEqual(['web_search', 'computer', 'gh/list']);
    expect(withComputerTool(['web_search', 'computer'], false)).toEqual(['web_search']);
  });

  it('finds the computer in steps, loops and helpers', () => {
    expect(usesComputer({ steps: [{ id: 'a', type: 'agent', prompt: '', tools: ['computer'] }] })).toBe(true);
    expect(
      usesComputer({
        steps: [{ id: 'l', type: 'for_each', items: '', steps: [{ id: 'a', type: 'agent', prompt: '', tools: ['computer'] }] }],
      }),
    ).toBe(true);
    expect(usesComputer({ agents: [{ id: 'h', name: 'H', instructions: '', tools: ['computer'] }], steps: [] })).toBe(true);
    expect(usesComputer({ steps: [{ id: 'a', type: 'agent', prompt: '', tools: ['web_search'] }] })).toBe(false);
  });

  it('leaves defaults out and keeps the setting through other edits', () => {
    const def: WorkflowDefinition = { steps: [] };
    expect(withComputer(def, { editMode: 'ask', whenNobodyAnswers: 'wait', allowOutside: false })).toEqual({ steps: [] });
    const set = withComputer(def, { editMode: 'free', timeoutSecs: 300, allowOutside: true });
    expect(set.computer).toEqual({ editMode: 'free', timeoutSecs: 300, allowOutside: true });
    expect(withFolder(set, 'C:\\work').computer).toEqual(set.computer);
    expect(withComputer(set, null).computer).toBeUndefined();
  });

  it('describes an agent that uses the computer', () => {
    const step: WorkflowStep = { id: 'a', type: 'agent', prompt: 'Tidy up', tools: ['computer'] };
    expect(computerText(step, t)).toBe('Uses the computer');
    expect(describeStep(step, t, {}, {}, [], {})).toContain('Uses the computer');
    expect(computerText({ ...step, tools: [] }, t)).toBeNull();
  });

  it('words the permission and the tool', () => {
    const p = { kind: 'computer', path: 'C:\\work', label: null, local: null } as const;
    expect(permissionText(p, t)).toBe(
      'Let agents run commands and change files in C:\\work (each still asks unless a rule allows it)',
    );
    expect(reviewText({ permission: p } as never, t)).toBe('It wants to let agents run commands and change files in C:\\work.');
    expect(agentToolsText(['computer'], t)).toContain('use the computer');
  });
});

describe('the editor', () => {
  it('ticks the computer on an agent step, hints at the folder, and shows the Computer section', () => {
    const latest = renderEditor({ steps: [{ id: 'agent', type: 'agent', prompt: 'Do it', tools: ['web_search'] }] });
    expect(screen.queryByRole('heading', { name: 'Computer' })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: COMPUTER_LABEL }));
    expect(latest.draft.definition.steps[0]).toMatchObject({ tools: ['web_search', 'computer'] });
    expect(screen.getByText(/The agent works only inside that folder/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Computer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: COMPUTER_LABEL }));
    expect(latest.draft.definition.steps[0]).toMatchObject({ tools: ['web_search'] });
    expect(screen.queryByRole('heading', { name: 'Computer' })).toBeNull();
  });

  it('edits the Computer section and round-trips it', () => {
    const latest = renderEditor({
      folder: 'C:\\work',
      steps: [{ id: 'agent', type: 'agent', prompt: 'Do it', tools: ['computer'] }],
      computer: { timeoutSecs: 60 },
    });
    expect(screen.queryByText(/The agent works only inside that folder/)).toBeNull();
    const section = screen.getByRole('heading', { name: 'Computer' }).closest('section') as HTMLElement;
    const ui = within(section);
    expect(ui.getByRole('radio', { name: 'Ask before changing files' })).toBeChecked();
    expect(ui.getByRole('radio', { name: 'Wait for me' })).toBeChecked();
    expect(ui.getByRole('checkbox', { name: /write outside the folder/ })).not.toBeChecked();
    fireEvent.click(ui.getByRole('radio', { name: 'Change files in the folder freely' }));
    fireEvent.click(ui.getByRole('radio', { name: 'Skip it' }));
    fireEvent.click(ui.getByRole('checkbox', { name: /write outside the folder/ }));
    fireEvent.change(ui.getByRole('spinbutton'), { target: { value: '300' } });
    expect(latest.draft.definition.computer).toEqual({
      editMode: 'free',
      whenNobodyAnswers: 'skip',
      timeoutSecs: 300,
      allowOutside: true,
    });
    // Back to defaults drops the key.
    fireEvent.click(ui.getByRole('radio', { name: 'Ask before changing files' }));
    fireEvent.click(ui.getByRole('radio', { name: 'Wait for me' }));
    fireEvent.click(ui.getByRole('checkbox', { name: /write outside the folder/ }));
    fireEvent.change(ui.getByRole('spinbutton'), { target: { value: '' } });
    expect(latest.draft.definition.computer).toBeUndefined();
    expect(latest.draft.definition.steps[0]).toMatchObject({ tools: ['computer'] });
  });

  it('says where the agent works and how it treats files, with a way to the Computer settings', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    vi.useFakeTimers();
    try {
      renderEditor({
        folder: 'C:/work/demo-shop',
        steps: [{ id: 'agent', type: 'agent', prompt: 'Do it', tools: ['computer'] }],
      });
      expect(screen.getByText('In demo-shop · asks before changing files')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Computer settings' }));
      vi.advanceTimersByTime(100);
      expect(scroll).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('says files change freely when the workflow is set that way', () => {
    renderEditor({
      folder: 'C:/work/demo-shop',
      computer: { editMode: 'free' },
      steps: [{ id: 'agent', type: 'agent', prompt: 'Do it', tools: ['computer'] }],
    });
    expect(screen.getByText('In demo-shop · changes files freely')).toBeInTheDocument();
  });

  it('offers to pick the folder when the workflow has none', async () => {
    ipc.pickWorkspaceFolder.mockResolvedValue('C:/work/shop');
    const latest = renderEditor({ steps: [{ id: 'agent', type: 'agent', prompt: 'Do it', tools: ['computer'] }] });
    fireEvent.click(screen.getByRole('button', { name: 'Pick the folder it works in' }));
    await waitFor(() => expect(latest.draft.definition.folder).toBe('C:/work/shop'));
  });

  it('keeps “write outside the folder” under Advanced, flagged while it is on', () => {
    renderEditor({
      folder: 'C:/work',
      steps: [{ id: 'agent', type: 'agent', prompt: 'Do it', tools: ['computer'] }],
      computer: { allowOutside: true },
    });
    const advanced = screen.getByText('Advanced').closest('details') as HTMLDetailsElement;
    expect(advanced.open).toBe(true);
    expect(within(advanced).getByRole('checkbox', { name: /write outside the folder/ })).toBeChecked();
    expect(within(advanced).getByText(/Not confined/)).toBeInTheDocument();
  });

  it('ticks the computer on a helper', () => {
    const latest = renderEditor({
      agents: [{ id: 'fixer', name: 'Fixer', instructions: 'Fix.', tools: ['web_search'] }],
      steps: [{ id: 'agent', type: 'agent', prompt: 'Do it', agents: ['fixer'] }],
    });
    const helper = document.querySelector('[data-helper-id="fixer"]') as HTMLElement;
    fireEvent.click(within(helper).getByRole('checkbox', { name: COMPUTER_LABEL }));
    expect(latest.draft.definition.agents?.[0].tools).toEqual(['web_search', 'computer']);
    expect(screen.getByRole('heading', { name: 'Computer' })).toBeInTheDocument();
  });
});
