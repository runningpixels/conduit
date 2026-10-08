import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowPermissionView, WorkflowStep } from '../ipc/contracts';
import { describeStep } from './describeStep';
import {
  needsCollections,
  newStep,
  stepOutputs,
  stepTakesModel,
  stepTypesFor,
  valuesAt,
  withCollection,
  withStepModel,
  withTopK,
} from './editorModel';
import { documentTitles, permissionText, reviewText } from './permissionText';
import { documentsStepSummary, researchReport, researchStepSummary } from './stepSummary';

const t = (id: string, values?: Record<string, unknown>) => `${id.split('.').pop()} ${JSON.stringify(values)}`;

describe('research step', () => {
  it('starts quick with an empty question, takes a model, and stays at the top level', () => {
    expect(newStep('research', new Set())).toEqual({ id: 'research', type: 'research', question: '', depth: 'quick' });
    expect(stepTakesModel('research')).toBe(true);
    expect(stepTypesFor(false)).toContain('research');
    expect(stepTypesFor(true)).not.toContain('research');
    const glm = { provider: 'z', model: 'glm' };
    const step = withStepModel(newStep('research', new Set()), glm);
    expect(step).toMatchObject({ model: glm });
    expect(withStepModel(step, null)).not.toHaveProperty('model');
  });

  it('describes itself by depth, and mentions its own model', () => {
    const base = { id: 'r', type: 'research', question: 'What changed in {{inputs.topic}}?', depth: 'quick' } as const;
    const labels = { topic: 'Topic' };
    expect(describeStep(base, t, labels)).toBe('researchQuick {"question":"What changed in [Topic]?"}');
    expect(describeStep({ ...base, depth: 'standard' }, t)).toContain('researchStandard');
    expect(describeStep({ ...base, model: { provider: 'z', model: 'glm' } }, t)).toContain('usingModel');
  });

  it('offers its report text, summary and sources to later steps', () => {
    const def: WorkflowDefinition = {
      steps: [newStep('research', new Set()), { id: 'n', type: 'notify', title: 'x' }],
    };
    const paths = valuesAt(def, [1]).map((r) => r.path);
    expect(paths).toEqual(
      expect.arrayContaining(['steps.research.text', 'steps.research.summary', 'steps.research.sources']),
    );
    expect(stepOutputs(def.steps[0]).find((o) => o.field === 'sources')?.list).toBe(true);
  });

  it('summarises a finished report with its weak sources and opens it', () => {
    const output = {
      reportArtifactId: 'a1',
      conversationId: 'c1',
      sources: [{ credibility: 'high' }, { credibility: 'low' }, { credibility: 'medium' }],
    };
    expect(researchStepSummary({ output }, t)).toBe('researchWeak {"count":3,"weak":1}');
    expect(researchStepSummary({ output: { ...output, sources: [{ credibility: 'high' }] } }, t)).toBe(
      'research {"count":1,"weak":0}',
    );
    expect(researchReport({ output })).toEqual({ artifactId: 'a1', conversationId: 'c1' });
    expect(researchStepSummary({ output: { text: 'x' } }, t)).toBeNull();
    expect(researchReport({ output: null })).toBeNull();
  });

  it('words its permission and review', () => {
    expect(permissionText({ kind: 'research', label: null, local: null }, t)).toBe('research undefined');
    const review = {
      runId: 'r',
      workflowId: 'w',
      workflowName: 'W',
      stepId: 'r',
      permission: { kind: 'research', label: null, local: null },
      url: null,
      requestedAt: '',
      expiresAt: '',
    } as const;
    expect(reviewText(review, t)).toBe('research undefined');
  });
});

describe('documents search step', () => {
  it('starts with no collections and the default passage count', () => {
    const step = newStep('search_documents', new Set());
    expect(step).toEqual({ id: 'docs', type: 'search_documents', collections: [], query: '', topK: 6 });
    expect(needsCollections({ steps: [step] })).toBe(true);
    expect(needsCollections({ steps: [withCollection(step, 'c1', true)] })).toBe(false);
  });

  it('adds and removes collections without duplicates, and clamps the passage count', () => {
    let step = newStep('search_documents', new Set());
    step = withCollection(withCollection(step, 'a', true), 'b', true);
    step = withCollection(step, 'a', true);
    expect(step).toMatchObject({ collections: ['b', 'a'] });
    expect(withCollection(step, 'b', false)).toMatchObject({ collections: ['a'] });
    expect(withTopK(step, 99)).toMatchObject({ topK: 20 });
    expect(withTopK(step, 0)).toMatchObject({ topK: 1 });
    expect(withTopK(step, Number.NaN)).toMatchObject({ topK: 1 });
  });

  it('describes itself, and offers passages to repeat over', () => {
    const step: WorkflowStep = { id: 'docs', type: 'search_documents', collections: ['a', 'b'], query: '{{steps.n.text}}' };
    expect(describeStep(step, t)).toContain('"query":"[n · text');
    const def: WorkflowDefinition = {
      steps: [
        step,
        { id: 'each', type: 'for_each', items: 'steps.docs.passages', steps: [{ id: 'x', type: 'template', template: '' }] },
      ],
    };
    const inLoop = valuesAt(def, [1, 0]).map((r) => r.path);
    expect(inLoop).toEqual(expect.arrayContaining(['item.document', 'item.citation', 'steps.docs.text']));
  });

  it('summarises passages and the documents they come from', () => {
    const output = {
      passages: [{ document: 'a.pdf' }, { document: 'a.pdf' }, { document: 'b.md' }],
      count: 3,
      text: '',
    };
    expect(documentsStepSummary({ output }, t)).toBe('passages {"count":3,"documents":2}');
    expect(documentsStepSummary({ output: { text: 'x' } }, t)).toBeNull();
  });

  it('words its permission with the collection titles', () => {
    const p: Extract<WorkflowPermissionView, { kind: 'documents' }> = {
      kind: 'documents',
      collections: [
        { id: 'a', title: 'Notes' },
        { id: 'b', title: 'Specs' },
      ],
      label: null,
      local: null,
    };
    expect(documentTitles(p)).toBe('Notes, Specs');
    expect(permissionText(p, t)).toBe('documents {"titles":"Notes, Specs"}');
  });
});
