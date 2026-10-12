import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition, WorkflowRunDetail, WorkflowRunStep } from '../../ipc/contracts';
import { STARTER_WORKFLOWS } from '../starters';
import { GAP_X, GAP_Y, LOOP_GAP, LOOP_HEAD, LOOP_PAD, NODE_H, NODE_W, START_H, START_ID, START_W, buildCanvas, problemsByStep, runStatuses, stepReferences } from './canvasModel';

const briefing = STARTER_WORKFLOWS.find((s) => s.id === 'briefing')!.definition as WorkflowDefinition;

const linear: WorkflowDefinition = {
  steps: [
    { id: 'fetch', type: 'fetch_page', urls: ['{{inputs.site}}'] },
    { id: 'sum', type: 'summarize', prompt: 'Sum up', input: '{{steps.fetch.text}} and {{steps.fetch.pages}}' },
    { id: 'save', type: 'save_artifact', title: 'Notes {{run.date}}', content: '{{steps.sum.text}}' },
  ],
};

function row(stepId: string, status: WorkflowRunStep['status'], iteration: number | null = null, output: unknown = null): WorkflowRunStep {
  return { id: `${stepId}-${iteration}`, runId: 'r', stepId, iteration, status, input: null, output, error: null, startedAt: '', finishedAt: null } as WorkflowRunStep;
}

function detail(rows: WorkflowRunStep[], status: WorkflowRunDetail['run']['status'] = 'running'): WorkflowRunDetail {
  return { run: { id: 'r', workflowId: 'w', status } as WorkflowRunDetail['run'], steps: rows };
}

describe('stepReferences', () => {
  it('finds every step output a value reads, deep inside objects and lists', () => {
    expect(stepReferences({ a: '{{steps.x.text}}', b: ['{{#each steps.y.pages}}{{item.url}}{{/each}}'], c: 1 })).toEqual([
      ['x', 'text'],
      ['y', 'pages'],
    ]);
    // A loop's `items` is a bare path, without braces.
    expect(stepReferences('steps.pick.data.stories')).toEqual([['pick', 'data']]);
  });
});

describe('buildCanvas', () => {
  it('lays a linear workflow out top to bottom on one centre line, after the start node', () => {
    const graph = buildCanvas(linear);
    expect(graph.nodes.map((n) => [n.id, n.kind, n.x + n.width / 2, n.y])).toEqual([
      [START_ID, 'start', 0, 0],
      ['fetch', 'step', 0, START_H + GAP_Y],
      ['sum', 'step', 0, START_H + GAP_Y + NODE_H + GAP_Y],
      ['save', 'step', 0, START_H + GAP_Y + 2 * (NODE_H + GAP_Y)],
    ]);
    expect(graph.width).toBe(Math.max(NODE_W, START_W));
    expect(graph.height).toBe(START_H + 3 * (NODE_H + GAP_Y));
  });

  it('wires the flow in order, and the data from each reference, once per pair', () => {
    const { edges } = buildCanvas(linear);
    expect(edges.filter((e) => e.kind === 'flow').map((e) => `${e.source}>${e.target}`)).toEqual(['__start>fetch', 'fetch>sum', 'sum>save']);
    expect(edges.filter((e) => e.kind === 'data').map((e) => [e.source, e.target, e.fields, e.adjacent])).toEqual([
      ['fetch', 'sum', ['text', 'pages'], true],
      ['sum', 'save', ['text'], true],
    ]);
    // A step reading one further back gets a wire of its own.
    const skip = buildCanvas({ steps: [...linear.steps, { id: 'note', type: 'notify', title: '{{steps.fetch.text}}' }] });
    expect(skip.edges.find((e) => e.id === 'data:fetch->note')?.adjacent).toBeUndefined();
  });

  it('draws a loop as a frame holding its steps, aligned with the chain', () => {
    const { nodes, edges } = buildCanvas(briefing);
    const loop = nodes.find((n) => n.id === 'read')!;
    expect(loop.kind).toBe('loop');
    expect(loop.x + loop.width / 2).toBe(0);
    // One card wide: the loop's steps run down inside the frame, like the chain.
    expect(loop.width).toBe(NODE_W + 2 * LOOP_PAD);
    expect(loop.height).toBe(LOOP_HEAD + 3 * NODE_H + 2 * LOOP_GAP + LOOP_PAD);
    const inner = nodes.filter((n) => n.parent === 'read');
    expect(inner.map((n) => [n.id, n.x, n.y])).toEqual([
      ['article', LOOP_PAD, LOOP_HEAD],
      ['gist', LOOP_PAD, LOOP_HEAD + NODE_H + LOOP_GAP],
      ['card', LOOP_PAD, LOOP_HEAD + 2 * (NODE_H + LOOP_GAP)],
    ]);
    expect(inner.map((n) => n.path)).toEqual([[2, 0], [2, 1], [2, 2]]);
    const flow = edges.filter((e) => e.kind === 'flow').map((e) => `${e.source}>${e.target}`);
    expect(flow.sort()).toEqual(['__start>fetch', 'article>gist', 'fetch>pick', 'gist>card', 'pick>read', 'read>write', 'write>save']);
    // The chain runs down, and so do a loop's own steps.
    const handles = (s: string, t: string) => edges.find((e) => e.source === s && e.target === t);
    expect(handles('pick', 'read')).toMatchObject({ sourceHandle: 'flow-bottom', targetHandle: 'flow-top' });
    expect(handles('article', 'gist')).toMatchObject({ sourceHandle: 'flow-bottom', targetHandle: 'flow-top' });
    // The loop reads the stories `pick` chose; the steps inside read each other.
    const data = edges.filter((e) => e.kind === 'data').map((e) => `${e.source}>${e.target}`);
    expect(data).toContain('pick>read');
    expect(data).toContain('article>gist');
    expect(data).toContain('read>write');
  });

  it('keeps an empty loop one node wide', () => {
    const { nodes, width } = buildCanvas({ steps: [{ id: 'l', type: 'for_each', items: 'steps.x.pages', steps: [] }] });
    expect(nodes[1].width).toBe(NODE_W + 2 * LOOP_PAD);
    expect(width).toBe(NODE_W + 2 * LOOP_PAD);
  });
});

describe('runStatuses', () => {
  it('is empty without a run, and idle for steps not reached yet', () => {
    expect(runStatuses(linear, null).size).toBe(0);
    const s = runStatuses(linear, detail([row('fetch', 'completed'), row('sum', 'running')]));
    expect(s.get('fetch')?.status).toBe('completed');
    expect(s.get('sum')?.status).toBe('running');
    expect(s.get('save')?.status).toBe('idle');
  });

  it('counts loop iterations, and a running iteration wins over finished ones', () => {
    const rows = [
      row('read', 'running'),
      row('article', 'completed', 0),
      row('gist', 'completed', 0),
      row('article', 'completed', 1),
      row('gist', 'running', 1),
    ];
    const s = runStatuses(briefing, detail(rows));
    expect(s.get('gist')?.status).toBe('running');
    expect(s.get('gist')?.iterations).toEqual({ reached: 2, total: null });
    expect(s.get('read')?.iterations).toEqual({ reached: 2, total: null });
    expect(s.get('card')?.status).toBe('idle');
  });

  it('knows the loop total once the loop has finished', () => {
    const rows = [row('read', 'completed', null, { items: [{}, {}, {}] }), row('article', 'completed', 2)];
    expect(runStatuses(briefing, detail(rows, 'completed')).get('read')?.iterations).toEqual({ reached: 3, total: 3 });
  });

  it('marks the step a paused run waits at', () => {
    const s = runStatuses(linear, detail([row('fetch', 'completed')], 'paused'), 'sum');
    expect(s.get('sum')?.status).toBe('waiting');
  });
});

describe('problemsByStep', () => {
  it('puts each problem on the steps it names, and the rest on the workflow', () => {
    const { byStep, general } = problemsByStep(
      ['Step "sum": unknown setting "on_error" — did you mean "onError"?', 'The workflow needs at least one step.', '“save” reads steps.nope.text, which no earlier step makes.'],
      linear,
    );
    expect([...byStep.keys()]).toEqual(['sum', 'save']);
    expect(general).toEqual(['The workflow needs at least one step.']);
  });
});

describe('buildCanvas with steps that wait for others', () => {
  const t = (id: string, after?: string[]): WorkflowDefinition['steps'][number] => ({ id, type: 'template', template: id, ...(after ? { after } : {}) });
  const flows = (g: ReturnType<typeof buildCanvas>) => g.edges.filter((e) => e.kind === 'flow').map((e) => `${e.source}>${e.target}`);
  const at = (g: ReturnType<typeof buildCanvas>, id: string) => g.nodes.find((n) => n.id === id)!;

  it('puts two steps that wait for the same step side by side, centred, in one layer', () => {
    const g = buildCanvas({ steps: [t('a'), t('b', ['a']), t('c', ['a'])] });
    expect(at(g, 'b').y).toBe(at(g, 'c').y);
    expect(at(g, 'b').y).toBe(at(g, 'a').y + NODE_H + GAP_Y);
    // Side by side and centred under a (which side each gets is dagre's call).
    expect(Math.abs(at(g, 'b').x - at(g, 'c').x)).toBe(NODE_W + GAP_X);
    expect(at(g, 'b').x + at(g, 'c').x + NODE_W).toBe(0);
    expect(at(g, 'a').x + NODE_W / 2).toBe(0);
    expect(flows(g)).toEqual(['__start>a', 'a>b', 'a>c']);
    expect(g.width).toBe(2 * NODE_W + GAP_X);
  });

  it('puts a join below every step it waits for, with a wire from each', () => {
    const g = buildCanvas({ steps: [t('a'), t('b', ['a']), t('c', ['a']), t('x', ['c']), t('join', ['b', 'x'])] });
    // Below everything it waits for; b may sit beside x, just above the join.
    expect(at(g, 'x').y).toBe(at(g, 'c').y + NODE_H + GAP_Y);
    expect(at(g, 'b').y).toBeGreaterThan(at(g, 'a').y);
    expect(at(g, 'join').y).toBe(at(g, 'x').y + NODE_H + GAP_Y);
    expect(at(g, 'join').y).toBeGreaterThan(at(g, 'b').y);
    expect(at(g, 'join').x + NODE_W / 2).toBe(0);
    expect(flows(g)).toEqual(['__start>a', 'a>b', 'a>c', 'c>x', 'b>join', 'x>join']);
  });

  it('hangs a step that waits for nothing off the start, beside the first step', () => {
    const g = buildCanvas({ steps: [t('a'), t('b', [])] });
    expect(at(g, 'a').y).toBe(at(g, 'b').y);
    expect(flows(g)).toEqual(['__start>a', '__start>b']);
  });

  it('draws the arms of a branch as labelled wires from their own handles', () => {
    const branch: WorkflowDefinition['steps'][number] = { id: 'if', type: 'branch', value: '{{steps.a.text}}', is: 'not_empty' };
    const g = buildCanvas({ steps: [t('a'), branch, t('yes', ['if.yes']), t('no', ['if.no']), t('merge', ['yes', 'no'])] });
    const arms = g.edges.filter((e) => e.arm);
    expect(arms.map((e) => [e.id, e.source, e.target, e.arm, e.sourceHandle])).toEqual([
      ['flow:if.yes->yes', 'if', 'yes', 'yes', 'arm-yes'],
      ['flow:if.no->no', 'if', 'no', 'no', 'arm-no'],
    ]);
    expect(at(g, 'yes').y).toBe(at(g, 'no').y);
    expect(at(g, 'yes').x).toBeLessThan(at(g, 'no').x);
    expect(at(g, 'merge').y).toBe(at(g, 'yes').y + NODE_H + GAP_Y);
  });

  it('gives both arms of one branch their own wire into a step that waits for both', () => {
    const branch: WorkflowDefinition['steps'][number] = { id: 'if', type: 'branch', value: 'x', is: 'empty' };
    const g = buildCanvas({ steps: [branch, t('end', ['if.yes', 'if.no'])] });
    expect(g.edges.filter((e) => e.kind === 'flow').map((e) => e.id)).toEqual(['flow:__start->if', 'flow:if.yes->end', 'flow:if.no->end']);
  });

  it('is the same drawing as before when no step says what it waits for', () => {
    const g = buildCanvas(linear);
    expect(flows(g)).toEqual(['__start>fetch', 'fetch>sum', 'sum>save']);
    expect(g.nodes.every((n) => n.x + n.width / 2 === 0)).toBe(true);
  });
});

describe('runStatuses with a branch', () => {
  it('reports a step that was not taken', () => {
    const def: WorkflowDefinition = { steps: [{ id: 'if', type: 'branch', value: 'x', is: 'empty' }, { id: 'yes', type: 'template', template: 'y', after: ['if.yes'] }] };
    const s = runStatuses(def, detail([row('if', 'completed'), row('yes', 'not_taken')], 'completed'));
    expect(s.get('yes')?.status).toBe('not_taken');
    expect(s.get('if')?.status).toBe('completed');
  });
});
