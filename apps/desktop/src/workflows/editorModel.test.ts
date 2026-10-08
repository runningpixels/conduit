import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowStep } from '../ipc/contracts';
import {
  allStepIds,
  clampFeedMinutes,
  newTrigger,
  triggerNeedsFolder,
  withTrigger,
  conditionNeedsText,
  defaultRetries,
  documentTarget,
  needsDocumentTarget,
  stepOutputs,
  stepTakesModel,
  stepTypesFor,
  withDocumentTarget,
  withOptionalInput,
  withConditionTest,
  withFolder,
  withOnlyIfChanged,
  insertReference,
  insertStep,
  listSourcesAt,
  moveStep,
  newInput,
  newStep,
  removeStep,
  stepAt,
  uniqueId,
  updateStep,
  valuesAt,
  withStepModel,
  withWorkflowModel,
} from './editorModel';
import { describeStep } from './describeStep';

const def: WorkflowDefinition = {
  inputs: [{ id: 'site', label: 'Site', default: 'https://example.com' }],
  steps: [
    { id: 'fetch', type: 'fetch_page', urls: ['{{inputs.site}}'] },
    {
      id: 'each',
      type: 'for_each',
      items: 'steps.fetch.pages',
      steps: [
        { id: 'summary', type: 'summarize', prompt: 'Summarize', input: '{{item.text}}' },
        { id: 'line', type: 'template', template: '- {{steps.summary.text}}' },
      ],
    },
    { id: 'doc', type: 'template', template: '' },
  ],
};

const paths = (refs: { path: string }[]) => refs.map((r) => r.path);

describe('ids', () => {
  it('makes unique, valid ids', () => {
    expect(uniqueId('fetch', new Set())).toBe('fetch');
    expect(uniqueId('fetch', new Set(['fetch', 'fetch_2']))).toBe('fetch_3');
    expect(uniqueId('My Site!', new Set())).toBe('my_site');
    expect(uniqueId('!!!', new Set())).toBe('step');
  });

  it('collects nested ids and gives new steps and inputs free ones', () => {
    const taken = allStepIds(def.steps);
    expect([...taken].sort()).toEqual(['doc', 'each', 'fetch', 'line', 'summary']);
    expect(newStep('fetch_page', taken)).toEqual({ id: 'fetch_2', type: 'fetch_page', urls: [''] });
    expect(newStep('save_artifact', taken)).toMatchObject({ id: 'save', format: 'markdown', mode: 'update' });
    expect(newInput(def.inputs!, 'Site')).toEqual({ id: 'site_2', label: 'Site', default: '' });
  });
});

describe('editing by path', () => {
  it('reads, updates, inserts, removes and moves nested steps without mutating', () => {
    const before = JSON.stringify(def);
    expect(stepAt(def.steps, [1, 1])?.id).toBe('line');
    expect(stepAt(def.steps, [1, 5])).toBeUndefined();

    const renamed = updateStep(def.steps, [1, 0], (s) => ({ ...s, id: 'sum' }));
    expect(stepAt(renamed, [1, 0])?.id).toBe('sum');

    const inserted = insertStep(def.steps, [1], newStep('template', allStepIds(def.steps)), 0);
    expect((stepAt(inserted, [1]) as Extract<WorkflowStep, { type: 'for_each' }>).steps.map((s) => s.id)).toEqual([
      'text',
      'summary',
      'line',
    ]);

    expect(removeStep(def.steps, [0]).map((s) => s.id)).toEqual(['each', 'doc']);
    expect(moveStep(def.steps, [2], -1).map((s) => s.id)).toEqual(['fetch', 'doc', 'each']);
    expect(moveStep(def.steps, [0], -1).map((s) => s.id)).toEqual(['fetch', 'each', 'doc']);
    expect(JSON.stringify(def)).toBe(before);
  });
});

describe('valuesAt', () => {
  it('offers inputs, the date, and only the steps before', () => {
    expect(paths(valuesAt(def, [0]))).toEqual(['inputs.site', 'run.date']);
    expect(paths(valuesAt(def, [2]))).toEqual([
      'inputs.site',
      'run.date',
      'steps.each.items',
      'steps.fetch.pages.0.links',
      'steps.fetch.pages',
      'steps.fetch.pages.0.title',
      'steps.fetch.pages.0.text',
      'steps.fetch.text',
    ]);
  });

  it('inside a loop, offers the item fields, index, earlier body steps and steps before the loop', () => {
    const inner = paths(valuesAt(def, [1, 1]));
    expect(inner).toEqual([
      'inputs.site',
      'run.date',
      'item.title',
      'item.text',
      'item.url',
      'item.links',
      'index',
      'steps.summary.text',
      'steps.fetch.pages.0.links',
      'steps.fetch.pages',
      'steps.fetch.pages.0.title',
      'steps.fetch.pages.0.text',
      'steps.fetch.text',
    ]);
    expect(inner).not.toContain('steps.line.text');
    expect(inner).not.toContain('steps.doc.text');
  });

  it('after a loop, its items expose each iteration by body step', () => {
    const later: WorkflowDefinition = {
      ...def,
      steps: [...def.steps, { id: 'each_again', type: 'for_each', items: 'steps.each.items', steps: [{ id: 'x', type: 'template', template: '' }] }],
    };
    expect(paths(valuesAt(later, [3, 0]))).toEqual(
      expect.arrayContaining(['item.summary.text', 'item.line.text']),
    );
  });

  it('lists what a loop can repeat over', () => {
    expect(paths(listSourcesAt(def, [2]))).toEqual(['steps.each.items', 'steps.fetch.pages.0.links', 'steps.fetch.pages']);
  });
});

describe('insertReference', () => {
  it('inserts at the caret, or at the end', () => {
    expect(insertReference('Hello !', 'inputs.name', 6)).toEqual({ text: 'Hello {{inputs.name}}!', caret: 21 });
    expect(insertReference('Hi ', 'run.date')).toEqual({ text: 'Hi {{run.date}}', caret: 15 });
  });
});

describe('model choices', () => {
  const glm = { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' };

  it('sets and clears the workflow default without leaving a key behind', () => {
    const withModel = withWorkflowModel(def, glm);
    expect(withModel.model).toEqual(glm);
    const cleared = withWorkflowModel(withModel, null);
    expect('model' in cleared).toBe(false);
    expect(cleared).toEqual(def);
  });

  it('sets and clears a step model on summarize and agent only', () => {
    const sum: WorkflowStep = { id: 's', type: 'summarize', prompt: 'p', input: 'i' };
    const agent: WorkflowStep = { id: 'a', type: 'agent', prompt: 'p' };
    const note: WorkflowStep = { id: 'n', type: 'notify', title: 't' };
    expect(withStepModel(sum, glm)).toMatchObject({ model: glm });
    expect('model' in withStepModel(withStepModel(sum, glm), null)).toBe(false);
    expect(withStepModel(agent, glm)).toMatchObject({ model: glm });
    expect(withStepModel(note, glm)).toBe(note);
  });

  it('round-trips through the JSON view', () => {
    const sum: WorkflowStep = { id: 's', type: 'summarize', prompt: 'p', input: 'i', model: glm };
    const full: WorkflowDefinition = { model: glm, steps: [sum, { id: 'a', type: 'agent', prompt: 'p', model: glm }] };
    expect(JSON.parse(JSON.stringify(full, null, 2))).toEqual(full);
  });

  it("mentions a step's own model, and only then", () => {
    const t = ((key: string, vars?: Record<string, unknown>) => `${key}|${JSON.stringify(vars ?? {})}`) as never;
    const base: WorkflowStep = { id: 's', type: 'summarize', prompt: 'p', input: 'i' };
    expect(describeStep(base, t)).not.toContain('usingModel');
    expect(describeStep({ ...base, model: glm } as WorkflowStep, t)).toContain(
      'workspace.workflows.step.usingModel|{"model":"z-ai/glm-5.3-flash"}',
    );
  });
});

describe('condition steps', () => {
  const t = ((key: string, vars?: Record<string, unknown>) => `${key}|${JSON.stringify(vars ?? {})}`) as never;

  it('starts as "changed", and is offered at the top level only', () => {
    expect(newStep('condition', new Set())).toEqual({ id: 'check', type: 'condition', value: '', is: 'changed' });
    expect(stepTypesFor(false)).toContain('condition');
    expect(stepTypesFor(true)).not.toContain('condition');
    expect(stepTypesFor(true)).toContain('for_each');
  });

  it('keeps `text` only for the tests that compare with one', () => {
    const base: WorkflowStep = { id: 'c', type: 'condition', value: '{{inputs.a}}', is: 'changed' };
    const contains = withConditionTest(base, 'contains');
    expect(contains).toMatchObject({ is: 'contains', text: '' });
    expect(conditionNeedsText('equals')).toBe(true);
    expect(conditionNeedsText('empty')).toBe(false);
    expect('text' in withConditionTest({ ...contains, text: 'x' } as WorkflowStep, 'not_empty')).toBe(false);
  });

  it('toggles onlyIfChanged on notify and save, and leaves other steps alone', () => {
    const note: WorkflowStep = { id: 'n', type: 'notify', title: 'x' };
    expect(withOnlyIfChanged(note, true)).toMatchObject({ onlyIfChanged: true });
    expect('onlyIfChanged' in withOnlyIfChanged(withOnlyIfChanged(note, true), false)).toBe(false);
    const tpl: WorkflowStep = { id: 't', type: 'template', template: '' };
    expect(withOnlyIfChanged(tpl, true)).toBe(tpl);
  });

  it('describes them', () => {
    const step: WorkflowStep = { id: 'c', type: 'condition', value: '{{steps.fetch.text}}', is: 'changed' };
    expect(describeStep(step, t)).toContain('workspace.workflows.step.condition.changed|');
    expect(describeStep({ ...step, is: 'contains', text: 'release' } as WorkflowStep, t)).toContain(
      'workspace.workflows.step.condition.contains|{"value":"[fetch · workspace.workflows.editor.field.text|{}]","text":"release"}',
    );
    const note: WorkflowStep = { id: 'n', type: 'notify', title: 'x', onlyIfChanged: true };
    expect(describeStep(note, t)).toContain('workspace.workflows.step.onlyIfChanged');
    expect(describeStep({ ...note, onlyIfChanged: undefined } as WorkflowStep, t)).not.toContain('onlyIfChanged');
  });
});

describe('data steps', () => {
  const def: WorkflowDefinition = {
    steps: [
      { id: 'file', type: 'read_file', path: 'metrics.csv' },
      { id: 'data', type: 'parse_data', input: '{{steps.file.text}}', format: 'csv' },
      { id: 'each', type: 'for_each', items: '', steps: [] },
    ],
  };

  it('creates empty read_file and parse_data steps with fresh ids', () => {
    expect(newStep('read_file', new Set(['file']))).toEqual({ id: 'file_2', type: 'read_file', path: '' });
    expect(newStep('parse_data', new Set())).toEqual({ id: 'data', type: 'parse_data', input: '', format: 'csv' });
    expect(stepTypesFor(true)).toEqual(expect.arrayContaining(['read_file', 'parse_data']));
  });

  it("offers a file's text and name, and a table's rows to repeat over", () => {
    const paths = valuesAt(def, [2]).map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'steps.file.text',
        'steps.file.name',
        'steps.data.rows',
        'steps.data.count',
        'steps.data.text',
        'steps.data.columns',
      ]),
    );
    expect(listSourcesAt(def, [2]).map((r) => r.path)).toEqual(
      expect.arrayContaining(['steps.data.rows', 'steps.data.columns']),
    );
  });

  it('sets and clears the folder', () => {
    const withIt = withFolder(def, 'C:\\Reports');
    expect(withIt.folder).toBe('C:\\Reports');
    expect('folder' in withFolder(withIt, null)).toBe(false);
    expect('folder' in withFolder(withIt, '  ')).toBe(false);
  });

  it('describes them', () => {
    const t = ((key: string, vars?: Record<string, unknown>) => `${key}|${JSON.stringify(vars ?? {})}`) as never;
    expect(describeStep(def.steps[0], t)).toContain('workspace.workflows.step.readFile|{"path":"metrics.csv"}');
    expect(describeStep(def.steps[1], t)).toContain('workspace.workflows.step.parseData|{"format":"CSV"}');
  });
});

describe('document steps', () => {
  it('start empty, take a model and the usual single retry, and stay at the top level', () => {
    const deck = newStep('edit_deck', new Set());
    const draft = newStep('edit_draft', new Set(['update_draft']));
    expect(deck).toEqual({ id: 'update_deck', type: 'edit_deck', deck: '', instructions: '' });
    expect(draft).toEqual({ id: 'update_draft_2', type: 'edit_draft', draft: '', instructions: '' });
    expect(stepTakesModel('edit_deck')).toBe(true);
    expect(stepTakesModel('edit_draft')).toBe(true);
    expect(defaultRetries('edit_deck')).toBe(1);
    expect(stepTypesFor(false)).toEqual(expect.arrayContaining(['edit_deck', 'edit_draft']));
    expect(stepTypesFor(true)).not.toContain('edit_deck');
    expect(stepTypesFor(true)).not.toContain('edit_draft');
  });

  it('points a step at a document, sets and clears its input and model', () => {
    let step: WorkflowStep = newStep('edit_deck', new Set());
    step = withDocumentTarget(step, 'deck-1');
    expect(documentTarget(step as never)).toBe('deck-1');
    step = withOptionalInput(step, '{{steps.data.text}}');
    expect(step).toMatchObject({ input: '{{steps.data.text}}' });
    expect('input' in withOptionalInput(step, '')).toBe(false);
    step = withStepModel(step, { provider: 'openrouter', model: 'glm-flash' });
    expect(step).toMatchObject({ model: { provider: 'openrouter', model: 'glm-flash' } });
    expect('model' in withStepModel(step, null)).toBe(false);
    const draft = withDocumentTarget(newStep('edit_draft', new Set()), 'draft-1');
    expect(draft).toMatchObject({ type: 'edit_draft', draft: 'draft-1' });
  });

  it('knows when a definition still needs its deck or draft picked', () => {
    const picked = withDocumentTarget(newStep('edit_deck', new Set()), 'deck-1');
    expect(needsDocumentTarget({ steps: [newStep('edit_deck', new Set())] })).toBe(true);
    expect(needsDocumentTarget({ steps: [picked] })).toBe(false);
    expect(needsDocumentTarget({ steps: [newStep('fetch_page', new Set())] })).toBe(false);
  });

  it('offers the reply, title and changed items to later steps, and describes the step', () => {
    const def: WorkflowDefinition = {
      steps: [withDocumentTarget({ ...newStep('edit_deck', new Set()), id: 'deck' }, 'deck-1'), newStep('notify', new Set())],
    };
    expect(valuesAt(def, [1]).map((r) => r.path)).toEqual(
      expect.arrayContaining(['steps.deck.reply', 'steps.deck.title', 'steps.deck.changed']),
    );
    const t = ((key: string, vars?: Record<string, unknown>) => `${key}|${JSON.stringify(vars ?? {})}`) as never;
    const step = { ...def.steps[0], instructions: 'Update the chart' } as WorkflowStep;
    expect(describeStep(step, t)).toBe('workspace.workflows.step.editDeck|{"instructions":"Update the chart"}');
    const modelled = withStepModel(step, { provider: 'p', model: 'm1' });
    expect(describeStep(modelled, t)).toContain('workspace.workflows.step.usingModel|{"model":"m1"}');
    expect(describeStep({ id: 'd', type: 'edit_draft', draft: 'x', instructions: 'Add a section' }, t)).toBe(
      'workspace.workflows.step.editDraft|{"instructions":"Add a section"}',
    );
  });
});

describe('a fetch step offers the first page', () => {
  it('offers its text on its own, for steps that read a single page (data files)', () => {
    const outputs = stepOutputs({ id: 'fetch', type: 'fetch_page', urls: ['{{inputs.url}}'] });
    expect(outputs).toContainEqual({ field: 'pages.0.text', list: false });
  });
});

describe('triggers and outputs', () => {
  const feedDef: WorkflowDefinition = {
    trigger: { kind: 'feed', url: 'https://example.com/feed.xml', everyMinutes: 30 },
    steps: [{ id: 'text', type: 'template', template: 'x' }],
  };

  it('offers the trigger fields as values only when the workflow has a trigger', () => {
    const paths = valuesAt(feedDef, [1]).map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(['trigger.title', 'trigger.link', 'trigger.summary', 'trigger.published', 'trigger.id']));
    expect(valuesAt({ steps: feedDef.steps }, [1]).some((r) => r.path.startsWith('trigger.'))).toBe(false);
    const folder = valuesAt({ trigger: { kind: 'folder' }, steps: [] }, [0]).map((r) => r.path);
    expect(folder).toEqual(expect.arrayContaining(['trigger.path', 'trigger.name', 'trigger.modified', 'trigger.bytes']));
  });

  it('sets, replaces and removes the trigger', () => {
    const none = withTrigger(feedDef, null);
    expect('trigger' in none).toBe(false);
    expect(withTrigger(none, newTrigger('feed')).trigger).toEqual({ kind: 'feed', url: '', everyMinutes: 30 });
    expect(newTrigger('folder')).toEqual({ kind: 'folder' });
  });

  it('keeps the feed interval within 15 minutes to a day', () => {
    expect(clampFeedMinutes(5)).toBe(15);
    expect(clampFeedMinutes(90000)).toBe(1440);
    expect(clampFeedMinutes(Number.NaN)).toBe(30);
    expect(clampFeedMinutes(45)).toBe(45);
  });

  it('asks for a folder before a folder trigger can work', () => {
    expect(triggerNeedsFolder({ trigger: { kind: 'folder' }, steps: [] })).toBe(true);
    expect(triggerNeedsFolder({ trigger: { kind: 'folder' }, folder: 'E:\\inbox', steps: [] })).toBe(false);
    expect(triggerNeedsFolder(feedDef)).toBe(false);
  });

  it('creates the two output steps and says what they produce', () => {
    const taken = new Set<string>();
    expect(newStep('export_file', taken)).toEqual({ id: 'export', type: 'export_file', name: '', content: '' });
    expect(newStep('save_memory', taken)).toEqual({ id: 'memory', type: 'save_memory', text: '' });
    expect(stepOutputs(newStep('export_file', taken)).map((o) => o.field)).toEqual(['path', 'name', 'bytes']);
    expect(stepOutputs(newStep('save_memory', taken)).map((o) => o.field)).toEqual(['memoryId', 'status']);
    expect(stepTypesFor(false)).toEqual(expect.arrayContaining(['export_file', 'save_memory']));
  });
});
