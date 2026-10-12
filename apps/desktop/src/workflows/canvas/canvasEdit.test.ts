import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../../ipc/contracts';
import { STARTER_WORKFLOWS } from '../starters';
import { buildCanvas } from './canvasModel';
import { TEMPLATE_FIELDS, addPlace, addStep, connectFlow, connectReference, deleteStep, disconnectFlow, dropPlace, flowChoices, moveStepTo, pathOf, wireChoices } from './canvasEdit';

const briefing = STARTER_WORKFLOWS.find((s) => s.id === 'briefing')!.definition as WorkflowDefinition;
const ids = (def: WorkflowDefinition) => def.steps.map((s) => (s.type === 'for_each' ? `${s.id}[${s.steps.map((c) => c.id).join(',')}]` : s.id));

describe('adding a step', () => {
  it('goes after the selected step, inside a selected loop, or at the end', () => {
    expect(addPlace(briefing, 'pick')).toEqual({ loop: null, index: 2, nested: false });
    expect(addPlace(briefing, 'read')).toEqual({ loop: 'read', index: 3, nested: true });
    expect(addPlace(briefing, 'gist')).toEqual({ loop: 'read', index: 2, nested: true });
    expect(addPlace(briefing, null)).toEqual({ loop: null, index: 5, nested: false });
  });

  it('adds the step with a fresh id where it goes', () => {
    const { def, id } = addStep(briefing, 'template', 'gist');
    expect(ids(def)).toEqual(['fetch', 'pick', `read[article,gist,${id},card]`, 'write', 'save']);
    const end = addStep(briefing, 'notify', null);
    expect(ids(end.def).at(-1)).toBe(end.id);
  });

  it('puts a kind a loop cannot hold right after the loop', () => {
    const { def, id } = addStep(briefing, 'condition', 'gist');
    expect(ids(def)).toEqual(['fetch', 'pick', 'read[article,gist,card]', id, 'write', 'save']);
  });

  it('deletes a step, and a loop with what is inside it', () => {
    expect(ids(deleteStep(briefing, 'gist'))).toEqual(['fetch', 'pick', 'read[article,card]', 'write', 'save']);
    expect(ids(deleteStep(briefing, 'read'))).toEqual(['fetch', 'pick', 'write', 'save']);
  });
});

describe('moving a step', () => {
  it('reorders the top-level list and a loop', () => {
    expect(ids(moveStepTo(briefing, 'save', { loop: null, index: 0 }))).toEqual(['save', 'fetch', 'pick', 'read[article,gist,card]', 'write']);
    expect(ids(moveStepTo(briefing, 'article', { loop: 'read', index: 2 }))).toEqual(['fetch', 'pick', 'read[gist,card,article]', 'write', 'save']);
  });

  it('moves into and out of a loop', () => {
    expect(ids(moveStepTo(briefing, 'write', { loop: 'read', index: 1 }))).toEqual(['fetch', 'pick', 'read[article,write,gist,card]', 'save']);
    expect(ids(moveStepTo(briefing, 'card', { loop: null, index: 4 }))).toEqual(['fetch', 'pick', 'read[article,gist]', 'write', 'card', 'save']);
  });

  it('never puts a loop, or a kind a loop cannot hold, inside a loop', () => {
    const withCondition = addStep(briefing, 'condition', 'save').def;
    const cond = withCondition.steps.at(-1)!.id;
    expect(moveStepTo(withCondition, cond, { loop: 'read', index: 0 })).toBe(withCondition);
    expect(moveStepTo(briefing, 'read', { loop: 'read', index: 0 })).toBe(briefing);
  });

  it('leaves the definition alone when the step lands where it was', () => {
    expect(moveStepTo(briefing, 'pick', { loop: null, index: 1 })).toBe(briefing);
  });
});

describe('dropPlace', () => {
  const graph = buildCanvas(briefing);
  const node = (id: string) => graph.nodes.find((n) => n.id === id)!;

  it('finds the slot in the top-level list from the drop height', () => {
    const write = node('write');
    // Dropped just above "fetch": first.
    expect(dropPlace(graph, 'write', { x: 0, y: node('fetch').y - 5 }, false)).toEqual({ loop: null, index: 0 });
    // Dropped below everything: last.
    expect(dropPlace(graph, 'write', { x: 0, y: node('save').y + 500 }, false)).toEqual({ loop: null, index: 4 });
    expect(write).toBeTruthy();
  });

  it('finds the slot inside a loop frame from the up-down position', () => {
    const frame = node('read');
    const x = frame.x + frame.width / 2;
    expect(dropPlace(graph, 'write', { x, y: frame.y + 10 }, false)).toEqual({ loop: 'read', index: 0 });
    expect(dropPlace(graph, 'write', { x, y: frame.y + frame.height - 10 }, false)).toEqual({ loop: 'read', index: 3 });
    // A loop dragged over a frame stays in the top-level list.
    expect(dropPlace(graph, 'read', { x, y: frame.y + 10 }, true).loop).toBeNull();
  });
});

describe('wires', () => {
  it('offers what an earlier step makes, and the fields that can take it', () => {
    const choices = wireChoices(briefing, 'pick', 'write');
    expect(choices.ok).toBe(true);
    if (!choices.ok) return;
    expect(choices.outputs.map((o) => o.path)).toEqual(['steps.pick.data', 'steps.pick.text']);
    expect(choices.fields.map((f) => f.key)).toEqual(['input', 'prompt']);
  });

  it('refuses a wire to a step that runs before the source', () => {
    expect(wireChoices(briefing, 'save', 'fetch')).toEqual({ ok: false, reason: 'later' });
  });

  it('offers only lists for a loop', () => {
    const choices = wireChoices(briefing, 'fetch', 'read');
    expect(choices.ok && choices.outputs.every((o) => o.list)).toBe(true);
  });

  it('puts the reference in the field: appended to text, a new page, or a loop list', () => {
    const write = connectReference(briefing, 'write', TEMPLATE_FIELDS.summarize[0], 'steps.pick.text');
    const input = (write.steps[3] as { input: string }).input;
    expect(input.endsWith('{{steps.pick.text}}')).toBe(true);
    expect(input.startsWith('{{#each steps.read.items}}')).toBe(true);

    const fetchDef: WorkflowDefinition = { steps: [{ id: 'a', type: 'template', template: 'x' }, { id: 'f', type: 'fetch_page', urls: [''] }] };
    const filled = connectReference(fetchDef, 'f', TEMPLATE_FIELDS.fetch_page[0], 'steps.a.text');
    expect((filled.steps[1] as { urls: string[] }).urls).toEqual(['{{steps.a.text}}']);

    const loop = connectReference(briefing, 'read', TEMPLATE_FIELDS.for_each[0], 'steps.fetch.pages');
    expect((loop.steps[2] as { items: string }).items).toBe('steps.fetch.pages');

    const inner = connectReference(briefing, 'card', TEMPLATE_FIELDS.template[0], 'steps.pick.text');
    expect(pathOf(inner.steps, 'card')).toEqual([2, 2]);
    expect(JSON.stringify(inner.steps[2])).toContain('{{steps.pick.text}}');
  });
});

describe('flow wires', () => {
  const tpl = (id: string, after?: string[]): WorkflowDefinition['steps'][number] => ({ id, type: 'template', template: id, ...(after ? { after } : {}) });
  const afters = (def: WorkflowDefinition) => def.steps.map((s) => s.after);

  it('makes a step wait for another as well, keeping what it waited for', () => {
    const def: WorkflowDefinition = { steps: [tpl('a'), tpl('b'), tpl('c')] };
    expect(afters(connectFlow(def, 'a', 'c'))).toEqual([undefined, undefined, ['b', 'a']]);
    // Waiting for the step before is the default: nothing to store.
    expect(connectFlow(def, 'b', 'c')).toBe(def);
  });

  it('refuses a wire to a step that is not later in the list', () => {
    const def: WorkflowDefinition = { steps: [tpl('a'), tpl('b')] };
    expect(flowChoices(def, 'b', 'a')).toEqual({ ok: false, reason: 'later' });
    expect(flowChoices(def, 'a', 'a')).toEqual({ ok: false, reason: 'later' });
    expect(connectFlow(def, 'b', 'a')).toBe(def);
  });

  it('asks for a side when the wire leaves a branch, and stores the arm', () => {
    const def: WorkflowDefinition = { steps: [{ id: 'if', type: 'branch', value: 'x', is: 'empty' }, tpl('a'), tpl('b')] };
    expect(flowChoices(def, 'if', 'b')).toEqual({ ok: true, branch: true });
    expect(flowChoices(def, 'a', 'b')).toEqual({ ok: true, branch: false });
    expect(afters(connectFlow(def, 'if', 'b', 'no'))).toEqual([undefined, undefined, ['a', 'if.no']]);
  });

  it('removes a dependency; the last one leaves a step that starts with the run', () => {
    const def: WorkflowDefinition = { steps: [tpl('a'), tpl('b'), tpl('c', ['b', 'a'])] };
    expect(afters(disconnectFlow(def, 'c', 'a'))).toEqual([undefined, undefined, undefined]);
    expect(afters(disconnectFlow(def, 'c', 'b'))).toEqual([undefined, undefined, ['a']]);
    const alone = disconnectFlow({ steps: [tpl('a'), tpl('b')] }, 'b', 'a');
    expect(alone.steps[1].after).toEqual([]);
    expect(disconnectFlow(def, 'c', 'zzz')).toBe(def);
  });

  it('rewires the steps that waited for a deleted step to what it waited for', () => {
    const def: WorkflowDefinition = { steps: [tpl('a'), tpl('b', ['a']), tpl('c', ['a']), tpl('d', ['b', 'c'])] };
    const next = deleteStep(def, 'b');
    expect(next.steps.map((s) => s.id)).toEqual(['a', 'c', 'd']);
    expect(afters(next)).toEqual([undefined, ['a'], ['a', 'c']]);
    // A plain chain is a plain removal.
    expect(afters(deleteStep({ steps: [tpl('a'), tpl('b'), tpl('c')] }, 'b'))).toEqual([undefined, undefined]);
  });

  it('spells out what a step waited for when its step before is deleted', () => {
    const def: WorkflowDefinition = { steps: [tpl('a'), tpl('p', ['a']), tpl('q'), tpl('r', ['a'])] };
    // q waited for p implicitly; with p gone it waits for what p waited for.
    expect(afters(deleteStep(def, 'p'))).toEqual([undefined, undefined, ['a']]);
  });

  it('replaces the arms of a deleted branch with what the branch waited for', () => {
    const def: WorkflowDefinition = {
      steps: [tpl('a'), { id: 'if', type: 'branch', value: 'x', is: 'empty' }, tpl('y', ['if.yes']), tpl('n', ['if.no']), tpl('m', ['y', 'n'])],
    };
    const next = deleteStep(def, 'if');
    expect(next.steps.map((s) => [s.id, s.after])).toEqual([['a', undefined], ['y', undefined], ['n', ['a']], ['m', ['y', 'n']]]);
  });
});
