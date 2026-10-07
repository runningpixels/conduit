import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowStep } from '../ipc/contracts';
import {
  allStepIds,
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
