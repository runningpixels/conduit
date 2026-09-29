/// The step editor's data model: pure functions over a `WorkflowDefinition`.
///
/// A step is addressed by its path: the indexes from the top-level list down
/// through nested `for_each` bodies (`[1, 0]` is the first step inside the
/// second step). Every edit returns a new definition; nothing is mutated.
///
/// `valuesAt` answers the editor's main question: at this step, what can a
/// field insert? Inputs, the run's date, every output of the steps before it
/// (in its own list and the lists around it), and inside a loop, the current
/// item's fields. It mirrors the backend's validation (`workflows::definition`),
/// so anything offered here is accepted on save.

import type { WorkflowDefinition, WorkflowInput, WorkflowStep } from '../ipc/contracts';

export type StepType = WorkflowStep['type'];
export type StepPath = readonly number[];

export const STEP_TYPES: readonly StepType[] = [
  'fetch_page',
  'web_search',
  'summarize',
  'template',
  'for_each',
  'save_artifact',
  'notify',
];

/// Most retries a step may ask for (the backend's `MAX_RETRIES`).
export const MAX_RETRIES = 5;

/// Retries when a step doesn't say (the backend's `default_retries`): a
/// network step twice, a model call once, nothing else. `null` for steps
/// where trying again means nothing.
export function defaultRetries(type: StepType): number | null {
  switch (type) {
    case 'fetch_page':
    case 'web_search':
      return 2;
    case 'summarize':
      return 1;
    default:
      return null;
  }
}

/// Most pages one fetch step may list (the backend's `MAX_URLS_PER_FETCH`).
export const MAX_URLS = 10;

const ID_PREFIX: Record<StepType, string> = {
  fetch_page: 'fetch',
  web_search: 'search',
  summarize: 'summary',
  template: 'text',
  for_each: 'each',
  save_artifact: 'save',
  notify: 'notify',
};

/// Every step id in the definition, nested ones included.
export function allStepIds(steps: readonly WorkflowStep[], into = new Set<string>()): Set<string> {
  for (const step of steps) {
    into.add(step.id);
    if (step.type === 'for_each') allStepIds(step.steps, into);
  }
  return into;
}

/// `base`, or `base_2`, `base_3`… — the first one not in `taken`.
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const clean = base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'step';
  if (!taken.has(clean)) return clean;
  for (let n = 2; ; n++) {
    const candidate = `${clean}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/// A new step of `type` with empty fields and an id not already taken.
export function newStep(type: StepType, taken: ReadonlySet<string>): WorkflowStep {
  const id = uniqueId(ID_PREFIX[type], taken);
  switch (type) {
    case 'fetch_page':
      return { id, type, urls: [''] };
    case 'web_search':
      return { id, type, query: '', maxResults: 5 };
    case 'summarize':
      return { id, type, prompt: '', input: '' };
    case 'template':
      return { id, type, template: '' };
    case 'for_each':
      return { id, type, items: '', steps: [] };
    case 'save_artifact':
      return { id, type, title: '', content: '', format: 'markdown', mode: 'update' };
    case 'notify':
      return { id, type, title: '', body: '' };
  }
}

/// A new input with a unique id derived from its label.
export function newInput(inputs: readonly WorkflowInput[], label: string): WorkflowInput {
  const taken = new Set(inputs.map((i) => i.id));
  return { id: uniqueId(label || 'input', taken), label, default: '' };
}

function mapList(
  steps: readonly WorkflowStep[],
  parent: StepPath,
  fn: (list: WorkflowStep[]) => WorkflowStep[],
): WorkflowStep[] {
  if (parent.length === 0) return fn([...steps]);
  const [head, ...rest] = parent;
  return steps.map((step, i) => {
    if (i !== head) return step;
    if (step.type !== 'for_each') throw new Error(`step ${step.id} has no nested steps`);
    return { ...step, steps: mapList(step.steps, rest, fn) };
  });
}

/// The step at `path`, if there is one.
export function stepAt(steps: readonly WorkflowStep[], path: StepPath): WorkflowStep | undefined {
  let list: readonly WorkflowStep[] = steps;
  let step: WorkflowStep | undefined;
  for (const index of path) {
    step = list[index];
    if (!step) return undefined;
    list = step.type === 'for_each' ? step.steps : [];
  }
  return step;
}

export function updateStep(
  steps: readonly WorkflowStep[],
  path: StepPath,
  fn: (step: WorkflowStep) => WorkflowStep,
): WorkflowStep[] {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  return mapList(steps, parent, (list) => list.map((s, i) => (i === index ? fn(s) : s)));
}

/// Insert `step` into the list at `parent`, at `index` (end when omitted).
export function insertStep(
  steps: readonly WorkflowStep[],
  parent: StepPath,
  step: WorkflowStep,
  index?: number,
): WorkflowStep[] {
  return mapList(steps, parent, (list) => {
    list.splice(index ?? list.length, 0, step);
    return list;
  });
}

export function removeStep(steps: readonly WorkflowStep[], path: StepPath): WorkflowStep[] {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  return mapList(steps, parent, (list) => list.filter((_, i) => i !== index));
}

/// Move a step up (`-1`) or down (`+1`) within its own list.
export function moveStep(steps: readonly WorkflowStep[], path: StepPath, delta: -1 | 1): WorkflowStep[] {
  const parent = path.slice(0, -1);
  const index = path[path.length - 1];
  return mapList(steps, parent, (list) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return list;
    [list[index], list[target]] = [list[target], list[index]];
    return list;
  });
}

/// Something a field can insert, as `{{path}}`.
export interface ValueRef {
  path: string;
  /// Where it comes from: an input, the run, a step (by id), or the loop item.
  source: { kind: 'input'; label: string } | { kind: 'run' } | { kind: 'step'; stepId: string } | { kind: 'item' };
  /// What it is, e.g. `text`, `pages`, `title`, `date`.
  field: string;
  /// True when it is a list (usable as a loop's items).
  list: boolean;
}

/// Fields of one element of a list, by what produced the list.
function itemFields(itemsPath: string, def: WorkflowDefinition): ValueRef[] {
  const item = (field: string, list = false): ValueRef => ({
    path: field === '' ? 'item' : `item.${field}`,
    source: { kind: 'item' },
    field: field || 'item',
    list,
  });
  if (itemsPath.endsWith('.pages')) {
    return [item('title'), item('text'), item('url'), item('links', true)];
  }
  if (itemsPath.endsWith('.results')) return [item('title'), item('snippet'), item('url')];
  if (itemsPath.endsWith('.items')) {
    // One object per iteration, holding that loop body's outputs by step id.
    const loopId = itemsPath.split('.')[1];
    const loop = findStep(def.steps, loopId);
    if (loop?.type === 'for_each') {
      return loop.steps.flatMap((inner) =>
        stepOutputs(inner).map((o) => item(`${inner.id}.${o.field}`, o.list)),
      );
    }
  }
  return [item('')];
}

function findStep(steps: readonly WorkflowStep[], id: string): WorkflowStep | undefined {
  for (const step of steps) {
    if (step.id === id) return step;
    if (step.type === 'for_each') {
      const inner = findStep(step.steps, id);
      if (inner) return inner;
    }
  }
  return undefined;
}

/// What a step produces, as later steps see it (see `workflows::definition`).
export function stepOutputs(step: WorkflowStep): { field: string; list: boolean }[] {
  switch (step.type) {
    case 'fetch_page':
      return [
        { field: 'text', list: false },
        { field: 'pages.0.title', list: false },
        { field: 'pages', list: true },
        { field: 'pages.0.links', list: true },
      ];
    case 'web_search':
      return [{ field: 'results', list: true }];
    case 'summarize':
      return step.schema ? [{ field: 'text', list: false }, { field: 'data', list: true }] : [{ field: 'text', list: false }];
    case 'template':
      return [{ field: 'text', list: false }];
    case 'for_each':
      return [{ field: 'items', list: true }];
    case 'save_artifact':
      return [{ field: 'artifactId', list: false }];
    case 'notify':
      return [];
  }
}

/// Everything a field of the step at `path` may insert, nearest first within
/// each group: inputs, the run's date, loop item fields, earlier steps.
export function valuesAt(def: WorkflowDefinition, path: StepPath): ValueRef[] {
  const refs: ValueRef[] = [];
  for (const input of def.inputs ?? []) {
    refs.push({ path: `inputs.${input.id}`, source: { kind: 'input', label: input.label }, field: input.id, list: false });
  }
  refs.push({ path: 'run.date', source: { kind: 'run' }, field: 'date', list: false });

  const earlier: ValueRef[] = [];
  let list: readonly WorkflowStep[] = def.steps;
  let innermostLoop: WorkflowStep | undefined;
  path.forEach((index, depth) => {
    for (const step of list.slice(0, index)) {
      for (const out of stepOutputs(step)) {
        earlier.push({ path: `steps.${step.id}.${out.field}`, source: { kind: 'step', stepId: step.id }, field: out.field, list: out.list });
      }
    }
    const here = list[index];
    if (depth < path.length - 1 && here?.type === 'for_each') {
      innermostLoop = here;
      list = here.steps;
    }
  });
  if (innermostLoop?.type === 'for_each' && innermostLoop.items) {
    refs.push(...itemFields(innermostLoop.items, def));
    refs.push({ path: 'index', source: { kind: 'item' }, field: 'index', list: false });
  }
  refs.push(...earlier.reverse());
  return refs;
}

/// The lists a `for_each` at `path` can repeat over.
export function listSourcesAt(def: WorkflowDefinition, path: StepPath): ValueRef[] {
  return valuesAt(def, path).filter((ref) => ref.list);
}

/// `{{path}}` inserted into `text` at `caret` (end when unknown).
export function insertReference(text: string, path: string, caret?: number): { text: string; caret: number } {
  const at = caret == null || caret < 0 || caret > text.length ? text.length : caret;
  const token = `{{${path}}}`;
  return { text: text.slice(0, at) + token + text.slice(at), caret: at + token.length };
}
