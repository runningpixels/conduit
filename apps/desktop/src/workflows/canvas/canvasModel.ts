/// The workflow canvas, as data: where each node goes, which wires join them,
/// and what each node's status is in a run. Pure functions over the
/// definition and run detail, so `WorkflowCanvas` only draws.
///
/// The engine runs steps in order (one level of `for_each` nesting), so the
/// layout is the order: a start node, then the steps top to bottom down one
/// centre line (a page scrolls down, so the drawing does too), each loop a
/// frame holding its own steps, also top to bottom: the drawing stays one card
/// wide, so it is readable without shrinking. There are no saved positions
/// yet; they come with the graph runner, when order stops being the whole
/// story.
///
/// Two kinds of wire: **flow** (what runs next, from the order) and **data**
/// (step B's settings read step A's output through `{{steps.A.…}}`).

import type { WorkflowDefinition, WorkflowRunDetail, WorkflowRunStep, WorkflowStep } from '../../ipc/contracts';
import type { StepPath } from '../editorModel';

export const NODE_W = 280;
export const NODE_H = 120;
export const START_W = 280;
export const START_H = 136;
export const GAP_X = 56;
export const GAP_Y = 56;
export const LOOP_PAD = 20;
export const LOOP_HEAD = 44;
/** Between the steps inside a loop frame. */
export const LOOP_GAP = 32;

export const START_ID = '__start';

export type CanvasNodeKind = 'start' | 'step' | 'loop';

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  /** Position: absolute for top-level nodes, relative to the frame for a loop's steps. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The loop frame holding this step, if any. */
  parent: string | null;
  step?: WorkflowStep;
  path?: StepPath;
}

/** Where a wire leaves and enters a node: the flow runs top to bottom, data along the right side. */
export type HandleId = 'flow-top' | 'flow-bottom' | 'flow-left' | 'flow-right' | 'data-in' | 'data-out';

export interface CanvasEdge {
  id: string;
  kind: 'flow' | 'data';
  source: string;
  target: string;
  sourceHandle: HandleId;
  targetHandle: HandleId;
  /** For a data wire: the outputs read, e.g. `["text", "pages"]`. */
  fields?: string[];
  /** A data wire between steps that already follow each other: the flow says it, so it is not drawn. */
  adjacent?: boolean;
}

export interface CanvasGraph {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** The drawing's size, for sizing the canvas to it. */
  width: number;
  height: number;
}

/** Every `steps.<id>.<field>` a value reads, as `[id, field]` pairs. */
export function stepReferences(value: unknown): [string, string][] {
  const found: [string, string][] = [];
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(/steps\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)/g)) found.push([m[1], m[2]]);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (v && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return found;
}

/** A step's own settings, without the steps nested in a loop. */
function ownSettings(step: WorkflowStep): unknown {
  if (step.type !== 'for_each') return step;
  const { steps: _inner, ...rest } = step;
  return rest;
}

/** The canvas for a definition: nodes laid out in order, flow and data wires. */
export function buildCanvas(def: WorkflowDefinition): CanvasGraph {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const flow = (source: string, target: string, sourceHandle: HandleId, targetHandle: HandleId) =>
    edges.push({ id: `flow:${source}->${target}`, kind: 'flow', source, target, sourceHandle, targetHandle });

  // Everything is centred on x = 0; a loop frame is as wide as its steps.
  nodes.push({ id: START_ID, kind: 'start', x: -START_W / 2, y: 0, width: START_W, height: START_H, parent: null });
  let y = START_H + GAP_Y;
  let previous = START_ID;
  let half = START_W / 2;
  def.steps.forEach((step, index) => {
    if (step.type === 'for_each') {
      const inner = step.steps;
      const width = NODE_W + 2 * LOOP_PAD;
      const rows = Math.max(1, inner.length);
      const height = LOOP_HEAD + rows * NODE_H + (rows - 1) * LOOP_GAP + LOOP_PAD;
      nodes.push({ id: step.id, kind: 'loop', x: -width / 2, y, width, height, parent: null, step, path: [index] });
      let innerPrevious: string | null = null;
      inner.forEach((child, childIndex) => {
        nodes.push({
          id: child.id,
          kind: 'step',
          x: LOOP_PAD,
          y: LOOP_HEAD + childIndex * (NODE_H + LOOP_GAP),
          width: NODE_W,
          height: NODE_H,
          parent: step.id,
          step: child,
          path: [index, childIndex],
        });
        if (innerPrevious) flow(innerPrevious, child.id, 'flow-bottom', 'flow-top');
        innerPrevious = child.id;
      });
      flow(previous, step.id, 'flow-bottom', 'flow-top');
      y += height + GAP_Y;
      half = Math.max(half, width / 2);
    } else {
      nodes.push({ id: step.id, kind: 'step', x: -NODE_W / 2, y, width: NODE_W, height: NODE_H, parent: null, step, path: [index] });
      flow(previous, step.id, 'flow-bottom', 'flow-top');
      y += NODE_H + GAP_Y;
      half = Math.max(half, NODE_W / 2);
    }
    previous = step.id;
  });

// Data wires: one per (source, target) pair, listing the fields read.
  const ids = new Set(nodes.map((n) => n.id));
  const wires = new Map<string, CanvasEdge>();
  for (const node of nodes) {
    if (!node.step) continue;
    for (const [source, field] of stepReferences(ownSettings(node.step))) {
      if (source === node.id || !ids.has(source)) continue;
      const id = `data:${source}->${node.id}`;
      const wire = wires.get(id) ?? { id, kind: 'data' as const, source, target: node.id, sourceHandle: 'data-out' as const, targetHandle: 'data-in' as const, fields: [] };
      if (!wire.fields!.includes(field)) wire.fields!.push(field);
      wires.set(id, wire);
    }
  }
  const flows = new Set(edges.filter((e) => e.kind === 'flow').map((e) => `${e.source}>${e.target}`));
  for (const wire of wires.values()) {
    if (flows.has(`${wire.source}>${wire.target}`)) wire.adjacent = true;
    edges.push(wire);
  }
  return { nodes, edges, width: 2 * half, height: y - GAP_Y };
}

// ── Run status ─────────────────────────────────────────────────────────────

export type NodeStatus = 'idle' | 'running' | 'completed' | 'failed' | 'skipped' | 'stopped' | 'reused' | 'waiting';

export interface NodeRun {
  status: NodeStatus;
  /** Every record of the step in this run: one, or one per loop iteration. */
  rows: WorkflowRunStep[];
  /** For a loop and the steps in it: iterations reached, and the total once known. */
  iterations?: { reached: number; total: number | null };
}

/** The order statuses win in when a step ran several times (loop iterations). */
const PRIORITY: NodeStatus[] = ['running', 'waiting', 'failed', 'stopped', 'completed', 'reused', 'skipped', 'idle'];

function outputItems(row: WorkflowRunStep | undefined): number | null {
  const out = row?.output as { items?: unknown } | null | undefined;
  return out && Array.isArray(out.items) ? out.items.length : null;
}

/**
 * Each node's status in `detail`: from its own record, or for a step inside a
 * loop, from its iterations (any running wins, then waiting, failed…). A step
 * with no record yet is `idle`. `waitingStepId` marks the step a paused run
 * waits at (a review or an "Ask me" question).
 */
export function runStatuses(def: WorkflowDefinition, detail: WorkflowRunDetail | null, waitingStepId?: string | null): Map<string, NodeRun> {
  const out = new Map<string, NodeRun>();
  if (!detail) return out;
  const byStep = new Map<string, WorkflowRunStep[]>();
  for (const row of detail.steps) {
    const list = byStep.get(row.stepId) ?? [];
    list.push(row);
    byStep.set(row.stepId, list);
  }
  const visit = (steps: readonly WorkflowStep[], loop: WorkflowStep | null) => {
    for (const step of steps) {
      const rows = byStep.get(step.id) ?? [];
      let status: NodeStatus = 'idle';
      for (const candidate of PRIORITY) {
        if (rows.some((r) => r.status === candidate)) {
          status = candidate;
          break;
        }
      }
      if (waitingStepId === step.id && detail.run.status === 'paused') status = 'waiting';
      const run: NodeRun = { status, rows };
      if (loop) {
        const reached = rows.reduce((max, r) => Math.max(max, (r.iteration ?? -1) + 1), 0);
        const total = outputItems(byStep.get(loop.id)?.find((r) => r.iteration == null));
        run.iterations = { reached, total };
      }
      out.set(step.id, run);
      if (step.type === 'for_each') {
        visit(step.steps, step);
        const reached = step.steps.reduce((max, child) => Math.max(max, out.get(child.id)?.iterations?.reached ?? 0), 0);
        run.iterations = { reached, total: outputItems(rows.find((r) => r.iteration == null)) };
      }
    }
  };
  visit(def.steps, null);
  return out;
}

// ── Problems ───────────────────────────────────────────────────────────────

/**
 * The checker's problems, by the step they name. Its sentences quote the step
 * id (`Step "fetch": …`); a quoted word that is not a step id is ignored, and
 * a problem naming no step belongs to the workflow as a whole.
 */
export function problemsByStep(problems: readonly string[], def: WorkflowDefinition): { byStep: Map<string, string[]>; general: string[] } {
  const ids = new Set<string>();
  const collect = (steps: readonly WorkflowStep[]) =>
    steps.forEach((s) => {
      ids.add(s.id);
      if (s.type === 'for_each') collect(s.steps);
    });
  collect(def.steps);
  const byStep = new Map<string, string[]>();
  const general: string[] = [];
  for (const problem of problems) {
    const named = [...problem.matchAll(/["“]([A-Za-z0-9_-]+)["”]/g)].map((m) => m[1]).filter((id) => ids.has(id));
    if (named.length === 0) {
      general.push(problem);
      continue;
    }
    for (const id of new Set(named)) byStep.set(id, [...(byStep.get(id) ?? []), problem]);
  }
  return { byStep, general };
}
