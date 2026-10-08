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

import type { WorkflowDefinition, WorkflowInput, WorkflowModel, WorkflowStep } from '../ipc/contracts';

export type StepType = WorkflowStep['type'];
export type StepPath = readonly number[];

export const STEP_TYPES: readonly StepType[] = [
  'fetch_page',
  'web_search',
  'read_file',
  'parse_data',
  'research',
  'search_documents',
  'summarize',
  'agent',
  'edit_deck',
  'edit_draft',
  'template',
  'for_each',
  'save_artifact',
  'ask',
  'notify',
  'condition',
];

/// The kinds offered in a list: a condition (like `onlyIfChanged`), the
/// steps that change a saved deck or draft, and research (long and costly)
/// only work at the top level, so a loop's body doesn't offer them.
export function stepTypesFor(nested: boolean): readonly StepType[] {
  return nested
    ? STEP_TYPES.filter(
        (type) => type !== 'condition' && type !== 'edit_deck' && type !== 'edit_draft' && type !== 'research',
      )
    : STEP_TYPES;
}

/// The tests a condition step offers, in menu order.
export const CONDITION_TESTS = ['changed', 'not_empty', 'empty', 'contains', 'not_contains', 'equals'] as const;

/// Tests that compare against a text of their own.
export function conditionNeedsText(is: string): boolean {
  return is === 'contains' || is === 'not_contains' || is === 'equals';
}

/// `step` with its test set to `is`: the `text` goes when the new test has no use for it.
export function withConditionTest(step: WorkflowStep, is: (typeof CONDITION_TESTS)[number]): WorkflowStep {
  if (step.type !== 'condition') return step;
  const { text, ...rest } = step;
  return conditionNeedsText(is) ? { ...rest, is, text: text ?? '' } : { ...rest, is };
}

/// `step` with `onlyIfChanged` on or off (off removes the key). Only notify and save steps have it.
export function withOnlyIfChanged(step: WorkflowStep, on: boolean): WorkflowStep {
  if (step.type !== 'notify' && step.type !== 'save_artifact') return step;
  const { onlyIfChanged: _drop, ...rest } = step;
  return (on ? { ...rest, onlyIfChanged: true } : rest) as WorkflowStep;
}

/// Tools an agent step may use (the backend's `AGENT_TOOLS`): read-only, and
/// none stops to ask for approval.
export const AGENT_TOOLS = ['web_search', 'web_fetch', 'current_time', 'calculator'] as const;

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
    case 'edit_deck':
    case 'edit_draft':
      return 1;
    default:
      return null;
  }
}

/// Step kinds that call a model, and so may pick their own (the backend only
/// accepts `model` on these).
export function stepTakesModel(type: StepType): boolean {
  return type === 'summarize' || type === 'agent' || type === 'edit_deck' || type === 'edit_draft' || type === 'research';
}

/// `def` with its default model set to `model`; `null` removes the key, so a
/// workflow that follows the chat model stores nothing.
export function withWorkflowModel(def: WorkflowDefinition, model: WorkflowModel | null): WorkflowDefinition {
  const { model: _drop, ...rest } = def;
  return model ? { ...rest, model } : rest;
}

/// `step` with its own model set to `model`; `null` removes the key. Other
/// step kinds come back unchanged.
export function withStepModel(step: WorkflowStep, model: WorkflowModel | null): WorkflowStep {
  if (!stepTakesModel(step.type)) {
    return step;
  }
  const { model: _drop, ...rest } = step as WorkflowStep & { model?: WorkflowModel };
  return (model ? { ...rest, model } : rest) as WorkflowStep;
}

/// Depths a research step offers (workflows have no `deep`), in menu order.
export const RESEARCH_DEPTHS = ['quick', 'standard'] as const;

/// Passages a documents search returns when the step doesn't say, and its bounds
/// (the backend's own).
export const DEFAULT_TOP_K = 6;
export const MAX_TOP_K = 20;

/// Formats a `parse_data` step reads, in menu order.
export const DATA_FORMATS = ['csv', 'tsv', 'json'] as const;

/// `def` with its folder set to `folder`; `null` (or blank) removes the key.
export function withFolder(def: WorkflowDefinition, folder: string | null): WorkflowDefinition {
  const { folder: _drop, ...rest } = def;
  return folder && folder.trim() ? { ...rest, folder } : rest;
}

/// Most pages one fetch step may list (the backend's `MAX_URLS_PER_FETCH`).
export const MAX_URLS = 10;

const ID_PREFIX: Record<StepType, string> = {
  fetch_page: 'fetch',
  web_search: 'search',
  read_file: 'file',
  parse_data: 'data',
  research: 'research',
  search_documents: 'docs',
  summarize: 'summary',
  template: 'text',
  for_each: 'each',
  save_artifact: 'save',
  agent: 'agent',
  edit_deck: 'update_deck',
  edit_draft: 'update_draft',
  ask: 'ask',
  notify: 'notify',
  condition: 'check',
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
    case 'read_file':
      return { id, type, path: '' };
    case 'parse_data':
      return { id, type, input: '', format: 'csv' };
    case 'research':
      return { id, type, question: '', depth: 'quick' };
    case 'search_documents':
      // Collections are picked in the editor: a new step cannot know yours.
      return { id, type, collections: [], query: '', topK: DEFAULT_TOP_K };
    case 'summarize':
      return { id, type, prompt: '', input: '' };
    case 'template':
      return { id, type, template: '' };
    case 'for_each':
      return { id, type, items: '', steps: [] };
    case 'save_artifact':
      return { id, type, title: '', content: '', format: 'markdown', mode: 'update' };
    case 'agent':
      return { id, type, prompt: '', input: '', tools: ['web_search', 'web_fetch'] };
    case 'edit_deck':
      return { id, type, deck: '', instructions: '' };
    case 'edit_draft':
      return { id, type, draft: '', instructions: '' };
    case 'ask':
      return { id, type, question: '', choices: [] };
    case 'notify':
      return { id, type, title: '', body: '' };
    case 'condition':
      return { id, type, value: '', is: 'changed' };
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
  if (itemsPath.endsWith('.sources')) return [item('title'), item('url'), item('credibility')];
  if (itemsPath.endsWith('.passages')) {
    return [item('document'), item('collection'), item('text'), item('citation')];
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
        { field: 'pages.0.text', list: false },
        { field: 'pages.0.title', list: false },
        { field: 'pages', list: true },
        { field: 'pages.0.links', list: true },
      ];
    case 'web_search':
      return [{ field: 'results', list: true }];
    case 'read_file':
      return [
        { field: 'text', list: false },
        { field: 'name', list: false },
      ];
    case 'parse_data':
      return [
        { field: 'rows', list: true },
        { field: 'count', list: false },
        { field: 'text', list: false },
        { field: 'columns', list: true },
      ];
    case 'research':
      return [
        { field: 'text', list: false },
        { field: 'summary', list: false },
        { field: 'title', list: false },
        { field: 'reportArtifactId', list: false },
        { field: 'sources', list: true },
      ];
    case 'search_documents':
      return [
        { field: 'text', list: false },
        { field: 'passages', list: true },
      ];
    case 'summarize':
      return step.schema ? [{ field: 'text', list: false }, { field: 'data', list: true }] : [{ field: 'text', list: false }];
    case 'template':
      return [{ field: 'text', list: false }];
    case 'for_each':
      return [{ field: 'items', list: true }];
    case 'save_artifact':
      return [{ field: 'artifactId', list: false }];
    case 'agent':
      return [
        { field: 'text', list: false },
        { field: 'toolCalls', list: true },
      ];
    case 'edit_deck':
    case 'edit_draft':
      return [
        { field: 'reply', list: false },
        { field: 'title', list: false },
        { field: 'changed', list: true },
      ];
    case 'ask':
      return [{ field: 'answer', list: false }];
    case 'notify':
    case 'condition':
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

/// A step that changes a saved deck or draft.
export function isDocumentEdit(step: WorkflowStep): step is Extract<WorkflowStep, { type: 'edit_deck' | 'edit_draft' }> {
  return step.type === 'edit_deck' || step.type === 'edit_draft';
}

/// The deck or draft id a document step targets (blank until one is picked).
export function documentTarget(step: Extract<WorkflowStep, { type: 'edit_deck' | 'edit_draft' }>): string {
  return step.type === 'edit_deck' ? step.deck : step.draft;
}

/// `step` pointed at the deck or draft `id`.
export function withDocumentTarget(step: WorkflowStep, id: string): WorkflowStep {
  if (step.type === 'edit_deck') return { ...step, deck: id };
  if (step.type === 'edit_draft') return { ...step, draft: id };
  return step;
}

/// `step` with `id` added to (or removed from) a documents search's collections.
export function withCollection(step: WorkflowStep, id: string, on: boolean): WorkflowStep {
  if (step.type !== 'search_documents') return step;
  const others = step.collections.filter((c) => c !== id);
  return { ...step, collections: on ? [...others, id] : others };
}

/// `step` with its passage count clamped to 1..=MAX_TOP_K.
export function withTopK(step: WorkflowStep, topK: number): WorkflowStep {
  if (step.type !== 'search_documents') return step;
  return { ...step, topK: Math.max(1, Math.min(MAX_TOP_K, Math.round(topK) || 1)) };
}

/// True when any top-level documents search still needs its collections picked.
export function needsCollections(def: WorkflowDefinition): boolean {
  return def.steps.some((step) => step.type === 'search_documents' && step.collections.length === 0);
}

/// `step` with its optional `input` set; blank removes the key (the step then
/// works from its instructions alone).
export function withOptionalInput(step: WorkflowStep, input: string): WorkflowStep {
  if (step.type !== 'edit_deck' && step.type !== 'edit_draft') return step;
  const { input: _drop, ...rest } = step;
  return (input === '' ? rest : { ...rest, input }) as WorkflowStep;
}

/// True when any top-level step still needs its deck or draft picked.
export function needsDocumentTarget(def: WorkflowDefinition): boolean {
  return def.steps.some((step) => isDocumentEdit(step) && documentTarget(step).trim() === '');
}
