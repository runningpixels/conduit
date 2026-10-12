/// The workflow canvas, as data: where each node goes, which wires join them,
/// and what each node's status is in a run. Pure functions over the
/// definition and run detail, so `WorkflowCanvas` only draws.
///
/// The layout comes from what each step waits for (`after`; without it, the
/// step before), placed by dagre: a start node, then ranks top to bottom (a
/// page scrolls down, so the drawing does too), with steps that run side by
/// side in lanes that make room for their branches and keep wires from
/// crossing. A plain list is one card wide, so it is readable without
/// shrinking. Each loop is a frame holding its own steps, top to bottom.
/// There are no saved positions.
///
/// Two kinds of wire: **flow** (what runs next, from the order) and **data**
/// (step B's settings read step A's output through `{{steps.A.…}}`).

import dagre from '@dagrejs/dagre';
import type { WorkflowDefinition, WorkflowRunDetail, WorkflowRunStep, WorkflowStep } from '../../ipc/contracts';
import type { StepPath } from '../editorModel';
import { dependencies, entryFor, parseEntry } from '../stepGraph';

export const NODE_W = 280;
export const NODE_H = 136;
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
export type HandleId = 'flow-top' | 'flow-bottom' | 'flow-left' | 'flow-right' | 'data-in' | 'data-out' | 'arm-yes' | 'arm-no';

export interface CanvasEdge {
  id: string;
  kind: 'flow' | 'data';
  source: string;
  target: string;
  sourceHandle: HandleId;
  targetHandle: HandleId;
  /** A flow wire leaving one side of a branch: the canvas labels it "Yes" / "No". */
  arm?: 'yes' | 'no';
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

/** A flow wire into `target`; from a branch's `arm` it leaves that side. */
function flowEdge(source: string, arm: 'yes' | 'no' | null, target: string): CanvasEdge {
  return {
    id: `flow:${entryFor(source, arm)}->${target}`,
    kind: 'flow',
    source,
    target,
    sourceHandle: arm ? (arm === 'yes' ? 'arm-yes' : 'arm-no') : 'flow-bottom',
    targetHandle: 'flow-top',
    ...(arm ? { arm } : {}),
  };
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

/** The canvas for a definition: nodes laid out in layers, flow and data wires. */
export function buildCanvas(def: WorkflowDefinition): CanvasGraph {
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const ids = new Set<string>();

  // What each top-level step waits for.
  const deps = dependencies(def.steps);

  const sizeOf = (step: WorkflowStep) => {
    if (step.type !== 'for_each') return { width: NODE_W, height: NODE_H };
    const rows = Math.max(1, step.steps.length);
    return { width: NODE_W + 2 * LOOP_PAD, height: LOOP_HEAD + rows * NODE_H + (rows - 1) * LOOP_GAP + LOOP_PAD };
  };

  // dagre places the start and the top-level steps; a loop's own steps sit
  // inside its frame. Positions come back as centres.
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: GAP_X, ranksep: GAP_Y, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  g.setNode(START_ID, { width: START_W, height: START_H });
  def.steps.forEach((step) => g.setNode(step.id, sizeOf(step)));
  // A branch's yes side sits left of its no side. (Only that: pinning other
  // siblings to list order made dagre cross wires it would otherwise not.)
  const yes = new Map<string, string>();
  const no = new Map<string, string>();
  def.steps.forEach((step) => {
    const entries = deps.get(step.id) ?? [];
    if (entries.length === 0) {
      // Heavy, so a step that starts with the run sits at the top, beside the
      // others that do, rather than sliding down next to what reads it.
      g.setEdge(START_ID, step.id, { weight: 8 });
    }
    for (const entry of entries) {
      const { id, arm } = parseEntry(entry);
      if (!g.hasNode(id)) continue;
      g.setEdge(id, step.id);
      if (arm === 'yes' && !yes.has(id)) yes.set(id, step.id);
      if (arm === 'no' && !no.has(id)) no.set(id, step.id);
    }
  });
  const constraints = [...yes].flatMap(([branch, left]) => {
    const right = no.get(branch);
    return right && right !== left ? [{ left, right }] : [];
  });
  dagre.layout(g, { constraints });
  // Centred on the start, which sits at the top: x = 0 is its middle, y = 0 its top.
  const origin = g.node(START_ID);
  const dx = -origin.x;
  const dy = -(origin.y - START_H / 2);
  const at = (id: string, width: number, height: number) => {
    const n = g.node(id);
    return { x: Math.round(n.x + dx - width / 2), y: Math.round(n.y + dy - height / 2) };
  };

  nodes.push({ id: START_ID, kind: 'start', x: -START_W / 2, y: 0, width: START_W, height: START_H, parent: null });
  let half = START_W / 2;
  let bottom = START_H;
  def.steps.forEach((step, index) => {
    const { width, height } = sizeOf(step);
    const { x, y } = at(step.id, width, height);
    half = Math.max(half, Math.abs(x), Math.abs(x + width));
    bottom = Math.max(bottom, y + height);
    if (step.type === 'for_each') {
      nodes.push({ id: step.id, kind: 'loop', x, y, width, height, parent: null, step, path: [index] });
      let innerPrevious: string | null = null;
      step.steps.forEach((child, childIndex) => {
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
        if (innerPrevious) edges.push(flowEdge(innerPrevious, null, child.id));
        innerPrevious = child.id;
      });
    } else {
      nodes.push({ id: step.id, kind: 'step', x, y, width, height, parent: null, step, path: [index] });
    }
  });
  // Flow wires follow the dependencies; a step that waits for nothing hangs off the start.
  for (const step of def.steps) {
    const entries = deps.get(step.id) ?? [];
    if (entries.length === 0) edges.push(flowEdge(START_ID, null, step.id));
    for (const entry of entries) {
      const { id, arm } = parseEntry(entry);
      edges.push(flowEdge(id, arm, step.id));
    }
  }
  for (const n of nodes) ids.add(n.id);

// Data wires: one per (source, target) pair, listing the fields read.
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
  return { nodes, edges, width: 2 * half, height: bottom };
}

// ── Run status ─────────────────────────────────────────────────────────────

export type NodeStatus = 'idle' | 'running' | 'completed' | 'failed' | 'skipped' | 'stopped' | 'reused' | 'waiting' | 'not_taken';

export interface NodeRun {
  status: NodeStatus;
  /** Every record of the step in this run: one, or one per loop iteration. */
  rows: WorkflowRunStep[];
  /** For a loop and the steps in it: iterations reached, and the total once known. */
  iterations?: { reached: number; total: number | null };
}

/** The order statuses win in when a step ran several times (loop iterations). */
const PRIORITY: NodeStatus[] = ['running', 'waiting', 'failed', 'stopped', 'completed', 'reused', 'skipped', 'not_taken', 'idle'];

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
