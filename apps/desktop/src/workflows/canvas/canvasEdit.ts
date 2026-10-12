/// Editing a workflow on the canvas, as pure functions over the definition:
/// add a step where the selection is, move a step to where it was dropped
/// (into or out of a loop too), and turn a wire drawn from one step to
/// another into a `{{steps.…}}` reference in one of the target's fields.
///
/// The engine runs steps in order, so every edit is an edit of the order;
/// the canvas lays itself out again from the result.

import type { WorkflowDefinition, WorkflowStep } from '../../ipc/contracts';
import {
  allStepIds,
  insertStep,
  newStep,
  removeStep,
  stepOutputs,
  stepTypesFor,
  valuesAt,
  type StepPath,
  type StepType,
  type ValueRef,
} from '../editorModel';
import { addDependency, entryFor, removeDependency, type Arm } from '../stepGraph';
import type { CanvasGraph, CanvasNode } from './canvasModel';

/** Where a step sits: in the top-level list (`loop: null`) or inside a loop, at `index`. */
export interface Place {
  loop: string | null;
  index: number;
}

/** The path of the step with `id`, or null. */
export function pathOf(steps: readonly WorkflowStep[], id: string): StepPath | null {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.id === id) return [i];
    if (step.type === 'for_each') {
      const j = step.steps.findIndex((s) => s.id === id);
      if (j >= 0) return [i, j];
    }
  }
  return null;
}

function placeOf(steps: readonly WorkflowStep[], id: string): Place | null {
  const path = pathOf(steps, id);
  if (!path) return null;
  return path.length === 1 ? { loop: null, index: path[0] } : { loop: steps[path[0]].id, index: path[1] };
}

/** Whether a step of `type` may go inside a loop (loops nest one level, some steps never). */
export function allowedInLoop(type: StepType): boolean {
  return stepTypesFor(true).includes(type) && type !== 'for_each';
}

/**
 * Where a new step goes, and which kinds may go there: after the selected
 * step in its own list, inside a selected loop at its end, or at the end of
 * the workflow when nothing is selected.
 */
export function addPlace(def: WorkflowDefinition, selectedId: string | null): Place & { nested: boolean } {
  if (selectedId) {
    const place = placeOf(def.steps, selectedId);
    const selected = def.steps.find((s) => s.id === selectedId);
    if (selected?.type === 'for_each') return { loop: selected.id, index: selected.steps.length, nested: true };
    if (place) return { loop: place.loop, index: place.index + 1, nested: place.loop !== null };
  }
  return { loop: null, index: def.steps.length, nested: false };
}

/** Add a new step of `type` where `addPlace` says; returns the definition and the new step's id. */
export function addStep(def: WorkflowDefinition, type: StepType, selectedId: string | null): { def: WorkflowDefinition; id: string } {
  const place = addPlace(def, selectedId);
  const step = newStep(type, allStepIds(def.steps));
  if (place.loop && !allowedInLoop(type)) {
    // Not allowed in a loop: it goes right after the loop instead.
    const loopIndex = def.steps.findIndex((s) => s.id === place.loop);
    return { def: { ...def, steps: insertStep(def.steps, [], step, loopIndex + 1) }, id: step.id };
  }
  const parent: StepPath = place.loop ? [def.steps.findIndex((s) => s.id === place.loop)] : [];
  return { def: { ...def, steps: insertStep(def.steps, parent, step, place.index) }, id: step.id };
}

/** Delete a step (a loop goes with the steps inside it); steps that waited for it wait for what it waited for. */
export function deleteStep(def: WorkflowDefinition, id: string): WorkflowDefinition {
  const path = pathOf(def.steps, id);
  return path ? { ...def, steps: removeStep(def.steps, path) } : def;
}

/**
 * Move the step `id` to `to`. `to.index` counts the target list without the
 * moved step, which is what a drop position measures. A loop never goes
 * inside a loop, and kinds a loop cannot hold stay out: those moves change
 * nothing.
 */
export function moveStepTo(def: WorkflowDefinition, id: string, to: Place): WorkflowDefinition {
  const path = pathOf(def.steps, id);
  if (!path) return def;
  const step = path.length === 1 ? def.steps[path[0]] : (def.steps[path[0]] as Extract<WorkflowStep, { type: 'for_each' }>).steps[path[1]];
  if (to.loop && (to.loop === id || !allowedInLoop(step.type))) return def;
  const without = removeStep(def.steps, path);
  let steps: WorkflowStep[];
  if (to.loop) {
    const loopIndex = without.findIndex((s) => s.id === to.loop);
    const loop = without[loopIndex];
    if (!loop || loop.type !== 'for_each') return def;
    steps = insertStep(without, [loopIndex], step, Math.max(0, Math.min(to.index, loop.steps.length)));
  } else {
    steps = insertStep(without, [], step, Math.max(0, Math.min(to.index, without.length)));
  }
  const same = JSON.stringify(steps) === JSON.stringify(def.steps);
  return same ? def : { ...def, steps };
}

/**
 * Where a step dropped at `center` (absolute canvas coordinates) belongs:
 * inside the loop frame it was dropped in (by its left-right position among
 * the loop's steps), otherwise in the top-level list (by its height among the
 * top-level nodes). The dragged node itself is left out of the count.
 */
export function dropPlace(graph: CanvasGraph, draggedId: string, center: { x: number; y: number }, draggedIsLoop: boolean): Place {
  const abs = (n: CanvasNode) => {
    if (!n.parent) return { x: n.x, y: n.y };
    const frame = graph.nodes.find((f) => f.id === n.parent)!;
    return { x: frame.x + n.x, y: frame.y + n.y };
  };
  if (!draggedIsLoop) {
    for (const frame of graph.nodes.filter((n) => n.kind === 'loop' && n.id !== draggedId)) {
      const inside = center.x >= frame.x && center.x <= frame.x + frame.width && center.y >= frame.y && center.y <= frame.y + frame.height;
      if (!inside) continue;
      const children = graph.nodes.filter((n) => n.parent === frame.id && n.id !== draggedId);
      const index = children.filter((c) => abs(c).y + c.height / 2 < center.y).length;
      return { loop: frame.id, index };
    }
  }
  const top = graph.nodes.filter((n) => !n.parent && n.kind !== 'start' && n.id !== draggedId);
  return { loop: null, index: top.filter((n) => n.y + n.height / 2 < center.y).length };
}

// ── Wires ─────────────────────────────────────────────────────────────────

/** A field of a step that can hold a reference, and how a reference goes in. */
export interface TemplateField {
  key: string;
  /** Catalog key for the field's name, as the step form labels it. */
  labelId: string;
  /** `text` appends `{{…}}`; `list` adds an entry (pages to fetch); `items` sets a loop's list. */
  kind: 'text' | 'list' | 'items';
}

const F = (key: string, labelId: string, kind: TemplateField['kind'] = 'text'): TemplateField => ({ key, labelId, kind });

/** The fields of each kind a wire can fill, in the order the step form shows them. */
export const TEMPLATE_FIELDS: Record<StepType, TemplateField[]> = {
  fetch_page: [F('urls', 'workspace.workflows.canvas.fieldPage', 'list')],
  web_search: [F('query', 'workspace.workflows.editor.search.query')],
  read_file: [F('path', 'workspace.workflows.editor.readFile.path')],
  parse_data: [F('input', 'workspace.workflows.editor.parseData.input')],
  research: [F('question', 'workspace.workflows.editor.research.question')],
  search_documents: [F('query', 'workspace.workflows.editor.searchDocs.query')],
  connector_tool: [],
  summarize: [F('input', 'workspace.workflows.editor.summarize.input'), F('prompt', 'workspace.workflows.editor.summarize.prompt')],
  agent: [F('input', 'workspace.workflows.editor.summarize.input'), F('prompt', 'workspace.workflows.editor.summarize.prompt')],
  edit_deck: [F('input', 'workspace.workflows.editor.summarize.input'), F('instructions', 'workspace.workflows.editor.editDoc.instructions')],
  edit_draft: [F('input', 'workspace.workflows.editor.summarize.input'), F('instructions', 'workspace.workflows.editor.editDoc.instructions')],
  template: [F('template', 'workspace.workflows.editor.template.text')],
  for_each: [F('items', 'workspace.workflows.editor.forEach.items', 'items')],
  save_artifact: [F('content', 'workspace.workflows.editor.save.content'), F('title', 'workspace.workflows.editor.save.title')],
  export_file: [F('content', 'workspace.workflows.editor.export.content'), F('name', 'workspace.workflows.editor.export.name')],
  save_memory: [F('text', 'workspace.workflows.editor.memory.text')],
  notify: [F('body', 'workspace.workflows.editor.notify.body'), F('title', 'workspace.workflows.editor.notify.title')],
  condition: [F('value', 'workspace.workflows.editor.condition.value'), F('text', 'workspace.workflows.editor.condition.text')],
  branch: [F('value', 'workspace.workflows.editor.condition.value'), F('text', 'workspace.workflows.editor.condition.text')],
  ask: [F('question', 'workspace.workflows.editor.ask.question')],
};

/** What a wire from `source` to `target` may insert, or why it may not. */
export function wireChoices(
  def: WorkflowDefinition,
  source: string,
  target: string,
): { ok: true; outputs: ValueRef[]; fields: TemplateField[] } | { ok: false; reason: 'later' | 'nothing' } {
  const targetPath = pathOf(def.steps, target);
  if (!targetPath) return { ok: false, reason: 'nothing' };
  const available = valuesAt(def, targetPath).filter((r) => r.source.kind === 'step' && r.source.stepId === source);
  const targetStep = targetPath.length === 1 ? def.steps[targetPath[0]] : (def.steps[targetPath[0]] as Extract<WorkflowStep, { type: 'for_each' }>).steps[targetPath[1]];
  const fields = TEMPLATE_FIELDS[targetStep.type];
  if (available.length === 0) {
    // The source runs later (or is the loop the target sits in): nothing to read yet.
    const sourcePath = pathOf(def.steps, source);
    const sourceStep = sourcePath ? def.steps[sourcePath[0]] : undefined;
    return { ok: false, reason: sourceStep && stepOutputs(sourceStep).length === 0 ? 'nothing' : 'later' };
  }
  if (fields.length === 0) return { ok: false, reason: 'nothing' };
  const outputs = available;
  // A loop repeats over a list: offer only lists for its items.
  if (fields[0].kind === 'items') {
    const lists = outputs.filter((o) => o.list);
    return lists.length ? { ok: true, outputs: lists, fields } : { ok: false, reason: 'nothing' };
  }
  return { ok: true, outputs, fields };
}

/** Put `{{path}}` into `field` of the step `target`. */
export function connectReference(def: WorkflowDefinition, target: string, field: TemplateField, path: string): WorkflowDefinition {
  const token = `{{${path}}}`;
  const fill = (step: WorkflowStep): WorkflowStep => {
    const record = step as unknown as Record<string, unknown>;
    if (field.kind === 'items') return { ...step, [field.key]: path } as WorkflowStep;
    if (field.kind === 'list') {
      const list = Array.isArray(record[field.key]) ? (record[field.key] as string[]) : [];
      const empty = list.findIndex((v) => !v.trim());
      const next = empty >= 0 ? list.map((v, i) => (i === empty ? token : v)) : [...list, token];
      return { ...step, [field.key]: next } as WorkflowStep;
    }
    const current = typeof record[field.key] === 'string' ? (record[field.key] as string) : '';
    const sep = current.trim() === '' ? '' : current.includes('\n') || current.length > 40 ? '\n\n' : ' ';
    return { ...step, [field.key]: current.trim() === '' ? token : `${current}${sep}${token}` } as WorkflowStep;
  };
  return {
    ...def,
    steps: def.steps.map((s) => {
      if (s.id === target) return fill(s);
      if (s.type === 'for_each' && s.steps.some((c) => c.id === target)) return { ...s, steps: s.steps.map((c) => (c.id === target ? fill(c) : c)) };
      return s;
    }),
  };
}

// ── Flow wires ────────────────────────────────────────────────────────────

/**
 * What a flow wire from the bottom of `source` to the top of `target` does:
 * `ok` with `branch: true` when `source` is a branch (the caller asks which
 * side), or why not: `later` when `target` is not after `source` in the list
 * (the list order is the run order, so a step can only wait for an earlier
 * one), `nested` for steps inside a loop (a loop's steps stay in a line).
 */
export function flowChoices(def: WorkflowDefinition, source: string, target: string): { ok: true; branch: boolean } | { ok: false; reason: 'later' | 'nested' } {
  const from = def.steps.findIndex((s) => s.id === source);
  const to = def.steps.findIndex((s) => s.id === target);
  if (from < 0 || to < 0) return { ok: false, reason: 'nested' };
  if (from >= to) return { ok: false, reason: 'later' };
  return { ok: true, branch: def.steps[from].type === 'branch' };
}

/** `target` also waits for `source` (or its yes / no side). */
export function connectFlow(def: WorkflowDefinition, source: string, target: string, arm: Arm | null = null): WorkflowDefinition {
  const choice = flowChoices(def, source, target);
  if (!choice.ok) return def;
  const steps = addDependency(def.steps, target, entryFor(source, arm));
  return JSON.stringify(steps) === JSON.stringify(def.steps) ? def : { ...def, steps };
}

/** `target` stops waiting for `entry` (a step id, or `<branch>.yes` / `.no`). */
export function disconnectFlow(def: WorkflowDefinition, target: string, entry: string): WorkflowDefinition {
  const steps = removeDependency(def.steps, target, entry);
  return JSON.stringify(steps) === JSON.stringify(def.steps) ? def : { ...def, steps };
}
