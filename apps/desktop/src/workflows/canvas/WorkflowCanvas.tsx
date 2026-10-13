/// A workflow drawn as connected nodes (React Flow): a start node, a node per
/// step, a frame per loop, the flow between them and dashed data wires where
/// one step reads another's output. During a run each node shows its status;
/// selecting one shows what it does and, for a run, what went in and came out.
///
/// The layout, wires and statuses come from `canvasModel.ts`; this file only
/// draws them. Editing (phase 11) plugs in through `editor`, `toolbar` and `panel`: drag
/// to reorder, wires that insert references, and the step form in the
/// inspector.

import '@xyflow/react/dist/style.css';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Handle,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useConnection,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useT, type Translate } from '../../i18n';
import { useFormatters } from '../../i18n/formatters';
import type { WorkflowDefinition, WorkflowRunDetail, WorkflowRunStep, WorkflowStep } from '../../ipc/contracts';
import { describeStep, type InputLabels } from '../describeStep';
import { STEP_TYPE_KEY } from '../stepTypes';
import { START_ID, buildCanvas, problemsByStep, runStatuses, type CanvasEdge, type CanvasNode, type NodeRun, type NodeStatus } from './canvasModel';

/** Written out, so the stylesheet's dead-rule check can see them. */
const STATUS_KEY: Record<Exclude<NodeStatus, 'idle'>, string> = {
  running: 'workspace.workflows.run.running',
  completed: 'workspace.workflows.run.completed',
  failed: 'workspace.workflows.run.failed',
  skipped: 'workspace.workflows.run.skipped',
  stopped: 'workspace.workflows.run.stopped',
  reused: 'workspace.workflows.run.reused',
  waiting: 'workspace.workflows.run.paused',
  not_taken: 'workspace.workflows.run.notTaken',
};

/** The badge class per status, written out for the stylesheet's dead-rule check. */
const STATUS_CLASS: Record<string, string> = {
  running: 'wfc-status wfc-status-running',
  waiting: 'wfc-status wfc-status-waiting',
  completed: 'wfc-status wfc-status-completed',
  failed: 'wfc-status wfc-status-failed',
  skipped: 'wfc-status wfc-status-skipped',
  stopped: 'wfc-status wfc-status-stopped',
  reused: 'wfc-status wfc-status-reused',
  not_taken: 'wfc-status wfc-status-not-taken',
};

interface NodeData extends Record<string, unknown> {
  kind: string;
  line: string;
  status: NodeStatus;
  statusText: string | null;
  iterations: string | null;
  flags: string[];
  problem: boolean;
  /** Flow wires may start here: editing, and not a step inside a loop. */
  flowEditable: boolean;
  /** A branch: two bottom handles, one per side. */
  branch: boolean;
  startLines?: string[];
}

/** What editing adds to the canvas (phase 11). */
export interface CanvasEditor {
  /** A step was dragged and let go; `center` is where, in canvas coordinates. */
  onNodeDragStop?: (node: CanvasNode, center: { x: number; y: number }) => void;
  /** A wire was drawn from one step's output to another step. */
  onConnect?: (source: string, target: string) => void;
  /** A wire was drawn from one step's bottom dot to a later step's top: it should wait for it. */
  onConnectFlow?: (source: string, target: string, arm: 'yes' | 'no' | null) => void;
  /** A selected flow wire was deleted: `target` stops waiting for `entry` (a step id, or `<branch>.yes` / `.no`). */
  onDisconnectFlow?: (target: string, entry: string) => void;
  /** Delete pressed on a selected step. */
  onDelete?: (id: string) => void;
}

export interface WorkflowCanvasProps {
  definition: WorkflowDefinition;
  labels?: InputLabels;
  connectorNames?: Record<string, string>;
  /** A run to show statuses from (live while it is running). */
  run?: WorkflowRunDetail | null;
  /** The steps a paused run waits at (a review or an "Ask me" question each). */
  waitingStepIds?: readonly string[];
  /** The checker's problems; steps they name are marked. */
  problems?: readonly string[];
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Replaces the built-in inspector (the editor shows the step form). */
  inspector?: (node: CanvasNode | null) => ReactNode;
  /**
   * The page layout: the canvas fills its container and this column sits
   * beside it at all times, for the selection (the start node included, so it
   * can be selected) or, with nothing selected, whatever the page shows then.
   * `details` is the built-in step inspector for the selected step.
   */
  panel?: (node: CanvasNode | null, details: ReactNode) => ReactNode;
  /** Drawn over the canvas, top left (add a step, canvas or list). */
  toolbar?: ReactNode;
  editor?: CanvasEditor;
  className?: string;
}

const StartNode = memo(function StartNode({ data, selected }: NodeProps<Node<NodeData>>) {
  return (
    <div className={`wfc-node wfc-start${selected ? ' is-selected' : ''}`}>
      <span className="wfc-kind">{data.kind}</span>
      {data.startLines?.map((line) => (
        <span key={line} className="wfc-line">
          {line}
        </span>
      ))}
      <Handle type="source" position={Position.Bottom} id="flow-bottom" isConnectable={false} />
    </div>
  );
});

/**
 * While a wire is being drawn from another step, a step's data input covers
 * the whole node, so letting go anywhere on it connects (the input itself is a
 * small hidden dot). Only then: the rest of the time it would swallow clicks.
 */
function useDropTarget(id: string): string {
  const connection = useConnection();
  return connection.inProgress && connection.fromNode?.id !== id ? ' wfc-drop-all' : '';
}

const StepNode = memo(function StepNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const t = useT();
  const drop = useDropTarget(id);
  return (
    <div className={`wfc-node wfc-step${selected ? ' is-selected' : ''}${data.problem ? ' has-problem' : ''}`} data-status={data.status}>
      <Handle type="target" position={Position.Top} id="flow-top" isConnectable={false} />
      <Handle type="target" position={Position.Left} id="flow-left" isConnectable={false} className="wfc-side-handle" />
      <span className="wfc-head">
        <span className="wfc-kind">{data.kind}</span>
        {data.problem ? <span className="wfc-needs-fix">{t('workspace.workflows.canvas.needsFix')}</span> : null}
        {data.statusText ? <span className={STATUS_CLASS[data.status] ?? 'wfc-status'}>{data.statusText}</span> : null}
      </span>
      <span className="wfc-line">{data.line}</span>
      {data.flags.length > 0 || data.iterations ? (
        <span className="wfc-flags">
          {data.iterations ? <span className="wfc-flag">{data.iterations}</span> : null}
          {data.flags.map((flag) => (
            <span key={flag} className="wfc-flag">
              {flag}
            </span>
          ))}
        </span>
      ) : null}
      {data.branch ? (
        <>
          <Handle type="source" position={Position.Bottom} id="flow-bottom" isConnectable={false} className="wfc-side-handle" />
          <Handle type="source" position={Position.Bottom} id="arm-yes" isConnectable={data.flowEditable} className="wfc-arm-handle wfc-arm-yes" />
          <Handle type="source" position={Position.Bottom} id="arm-no" isConnectable={data.flowEditable} className="wfc-arm-handle wfc-arm-no" />
          {/* Which dot is which, while wires can be drawn from them. */}
          {data.flowEditable ? (
            <>
              <span className="wfc-arm-tag wfc-arm-yes" aria-hidden="true">
                {t('workspace.workflows.canvas.arm.yes')}
              </span>
              <span className="wfc-arm-tag wfc-arm-no" aria-hidden="true">
                {t('workspace.workflows.canvas.arm.no')}
              </span>
            </>
          ) : null}
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} id="flow-bottom" isConnectable={data.flowEditable} className={data.flowEditable ? 'wfc-flow-out' : undefined} />
      )}
      <Handle type="source" position={Position.Right} id="flow-right" isConnectable={false} className="wfc-side-handle" />
      <Handle type="target" position={Position.Right} id="data-in" className={`wfc-data-handle wfc-data-in${drop}`} />
      <Handle type="source" position={Position.Right} id="data-out" className="wfc-data-handle wfc-data-out" />
    </div>
  );
});

const LoopNode = memo(function LoopNode({ id, data, selected }: NodeProps<Node<NodeData>>) {
  const t = useT();
  const drop = useDropTarget(id);
  return (
    <div className={`wfc-loop${selected ? ' is-selected' : ''}${data.problem ? ' has-problem' : ''}`} data-status={data.status}>
      <Handle type="target" position={Position.Top} id="flow-top" isConnectable={false} />
      <span className="wfc-loop-head">
        <span className="wfc-kind">{data.kind}</span>
        <span className="wfc-line">{data.line}</span>
        {data.problem ? <span className="wfc-needs-fix">{t('workspace.workflows.canvas.needsFix')}</span> : null}
        {data.iterations ? <span className="wfc-flag wfc-iter">{data.iterations}</span> : null}
        {data.statusText ? <span className={STATUS_CLASS[data.status] ?? 'wfc-status'}>{data.statusText}</span> : null}
      </span>
      <Handle type="source" position={Position.Bottom} id="flow-bottom" isConnectable={data.flowEditable} className={data.flowEditable ? 'wfc-flow-out' : undefined} />
      <Handle type="target" position={Position.Right} id="data-in" className={`wfc-data-handle wfc-data-in${drop}`} />
      <Handle type="source" position={Position.Right} id="data-out" className="wfc-data-handle wfc-data-out" />
    </div>
  );
});

const NODE_TYPES = { wfStart: StartNode, wfStep: StepNode, wfLoop: LoopNode };

function iterationText(t: Translate, run: NodeRun | undefined): string | null {
  const it = run?.iterations;
  if (!it || it.reached === 0) return null;
  return it.total != null ? t('workspace.workflows.canvas.iterationsOf', { reached: it.reached, total: it.total }) : t('workspace.workflows.canvas.iterations', { count: it.reached });
}

function startLines(t: Translate, def: WorkflowDefinition, labels: InputLabels): string[] {
  const lines = [
    def.trigger?.kind === 'feed'
      ? t('workspace.workflows.trigger.feed')
      : def.trigger?.kind === 'folder'
        ? t('workspace.workflows.trigger.folder')
        : t('workspace.workflows.trigger.none'),
  ];
  const inputs = (def.inputs ?? []).map((i) => labels[i.id] ?? i.label).filter(Boolean);
  if (inputs.length > 0) lines.push(t('workspace.workflows.canvas.inputs', { names: inputs.join(', ') }));
  return lines;
}

/** Least zoom the page layout fits to: below it text gets hard to read, so the canvas pans instead. */
const READABLE_ZOOM = 0.85;
/** How far the page layout shrinks a drawing to show its whole width (two or three lanes side by side). */
const WIDE_ZOOM = 0.75;
const NO_WAITS: readonly string[] = [];
const FIT_PAD = 40;
/** Room at the top for the toolbar drawn over the canvas (add a step, canvas or list, zoom). */
const FIT_TOP = 72;

type Flow = ReturnType<typeof useReactFlow>;

/**
 * Fits the drawing to the canvas. In the page layout the zoom stays between
 * READABLE_ZOOM and 1. A drawing that fits shrinks to fit; one too tall to fit
 * even at READABLE_ZOOM has to be panned anyway, so it shows at full size
 * (width allowing), starting at its top. Lanes side by side may shrink it to
 * WIDE_ZOOM when that shows them all; wider still, it starts at its left edge,
 * so what's cut off is only on the right, not half a lane on each side.
 * Returns whether it is cut off that way.
 */
function fitDrawing(flow: Flow, el: HTMLElement | null, fill: boolean): boolean {
  if (!fill || !el) {
    void flow.fitView({ padding: 0.15 });
    return false;
  }
  const nodes = flow.getNodes();
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (nodes.length === 0 || w === 0 || h === 0) return false;
  const b = flow.getNodesBounds(nodes);
  if (b.width === 0 || b.height === 0) return false;
  const byWidth = Math.min(1, (w - FIT_PAD * 2) / b.width);
  const byHeight = (h - FIT_TOP - FIT_PAD) / b.height;
  const floor = byWidth >= WIDE_ZOOM ? Math.min(READABLE_ZOOM, byWidth) : READABLE_ZOOM;
  const zoom = Math.max(floor, byHeight >= floor ? Math.min(byWidth, byHeight) : byWidth);
  const fits = b.width * zoom <= w - FIT_PAD * 2 + 1;
  const x = fits ? (w - b.width * zoom) / 2 - b.x * zoom : FIT_PAD - b.x * zoom;
  const y = b.height * zoom + FIT_TOP + FIT_PAD > h ? FIT_TOP - b.y * zoom : Math.max(FIT_TOP, (h - b.height * zoom) / 2) - b.y * zoom;
  void flow.setViewport({ x, y, zoom });
  return !fits;
}

function CanvasControls({ expanded, onExpand, onFit }: { expanded: boolean; onExpand: () => void; onFit: () => void }) {
  const t = useT();
  const flow = useReactFlow();
  return (
    <Panel position="top-right" className="wfc-controls">
      <button type="button" className="btn ghost" aria-label={t('workspace.workflows.canvas.zoomOut')} title={t('workspace.workflows.canvas.zoomOut')} onClick={() => void flow.zoomOut()}>
        −
      </button>
      <button type="button" className="btn ghost" aria-label={t('workspace.workflows.canvas.zoomIn')} title={t('workspace.workflows.canvas.zoomIn')} onClick={() => void flow.zoomIn()}>
        +
      </button>
      <button type="button" className="btn ghost" onClick={onFit}>
        {t('workspace.workflows.canvas.fit')}
      </button>
      <button type="button" className="btn ghost" aria-pressed={expanded} onClick={onExpand}>
        {expanded ? t('workspace.workflows.canvas.exitFullScreen') : t('workspace.workflows.canvas.fullScreen')}
      </button>
    </Panel>
  );
}

/**
 * Fits the view when the set of nodes changes (a step added or removed), and
 * when the canvas gets a new size: it is often first drawn inside a closed
 * section, at zero size, and fitting then leaves it tiny in a corner.
 */
function FitOnChange({
  signature,
  box,
  fill,
  onFit,
}: {
  signature: string;
  box: React.RefObject<HTMLDivElement | null>;
  fill: boolean;
  /** Each fit says whether the drawing is wider than the canvas. */
  onFit: (cutOff: boolean) => void;
}) {
  const flow = useReactFlow();
  useEffect(() => {
    const id = requestAnimationFrame(() => onFit(fitDrawing(flow, box.current, fill)));
    return () => cancelAnimationFrame(id);
  }, [flow, signature, box, fill, onFit]);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let last = '';
    const observer = new ResizeObserver(() => {
      const size = `${Math.round(el.clientWidth / 40)}x${Math.round(el.clientHeight / 40)}`;
      if (el.clientWidth === 0 || size === last) return;
      last = size;
      onFit(fitDrawing(flow, el, fill));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [flow, box, fill, onFit]);
  return null;
}

/**
 * Brings the selected step into view when it is somewhere the canvas doesn't
 * show, as a step just added at the end of a long drawing is. A step that is
 * even partly in view stays put: it was clicked, or can be seen.
 */
function RevealSelected({ id, box }: { id: string | null; box: React.RefObject<HTMLDivElement | null> }) {
  const flow = useReactFlow();
  useEffect(() => {
    if (!id) return;
    // After the fit a new step also triggers, which runs in the same frame first.
    const frame = requestAnimationFrame(() => {
      const el = box.current;
      const node = flow.getInternalNode(id);
      if (!el || !node) return;
      const at = node.internals.positionAbsolute;
      const { x, y, zoom } = flow.getViewport();
      const w = node.measured?.width ?? node.width ?? 0;
      const h = node.measured?.height ?? node.height ?? 0;
      const left = at.x * zoom + x;
      const top = at.y * zoom + y;
      const outside = left + w * zoom < 0 || top + h * zoom < 0 || left > el.clientWidth || top > el.clientHeight;
      if (outside) void flow.setCenter(at.x + w / 2, at.y + h / 2, { zoom, duration: 200 });
    });
    return () => cancelAnimationFrame(frame);
  }, [flow, id, box]);
  return null;
}

/** Stable defaults: a fresh `{}` per render would rebuild every node every render. */
const NO_LABELS: InputLabels = {};
const NO_NAMES: Record<string, string> = {};
const NO_PROBLEMS: readonly string[] = [];

function Canvas({
  definition,
  labels = NO_LABELS,
  connectorNames = NO_NAMES,
  run = null,
  waitingStepIds = NO_WAITS,
  problems = NO_PROBLEMS,
  selectedId: controlledId,
  onSelect,
  inspector,
  panel,
  toolbar,
  editor,
  className,
}: WorkflowCanvasProps) {
  const fill = panel !== undefined;
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  const selectedId = controlledId !== undefined ? controlledId : ownSelected;
  const select = useCallback(
    (id: string | null) => {
      if (controlledId === undefined) setOwnSelected(id);
      onSelect?.(id);
    },
    [controlledId, onSelect],
  );

  const graph = useMemo(() => buildCanvas(definition), [definition]);
  const statuses = useMemo(() => runStatuses(definition, run, waitingStepIds), [definition, run, waitingStepIds]);
  const { byStep: problemSteps } = useMemo(() => problemsByStep(problems, definition), [problems, definition]);

  const derived: Node<NodeData>[] = useMemo(
    () =>
      graph.nodes.map((n) => {
        const step = n.step;
        const nodeRun = statuses.get(n.id);
        const status: NodeStatus = nodeRun?.status ?? 'idle';
        const data: NodeData = step
          ? {
              kind: t(STEP_TYPE_KEY[step.type]),
              line: describeStep(step, t, labels, connectorNames, definition.steps),
              status,
              statusText: status === 'idle' ? null : t(STATUS_KEY[status]),
              iterations: iterationText(t, nodeRun),
              flags: step.onError === 'skip' ? [t('workspace.workflows.step.continuesOnError')] : [],
              problem: problemSteps.has(n.id),
              flowEditable: Boolean(editor?.onConnectFlow) && n.parent === null,
              branch: step.type === 'branch',
            }
          : {
              kind: t('workspace.workflows.canvas.start'),
              line: '',
              status: 'idle',
              statusText: null,
              iterations: null,
              flags: [],
              problem: false,
              flowEditable: false,
              branch: false,
              startLines: startLines(t, definition, labels),
            };
        return {
          id: n.id,
          type: n.kind === 'start' ? 'wfStart' : n.kind === 'loop' ? 'wfLoop' : 'wfStep',
          position: { x: n.x, y: n.y },
          width: n.width,
          height: n.height,
          data,
          parentId: n.parent ?? undefined,
          // While editing, a loop's step may be dragged out of its frame.
          extent: n.parent && !editor?.onNodeDragStop ? ('parent' as const) : undefined,
          selected: n.id === selectedId,
          draggable: Boolean(editor?.onNodeDragStop) && n.kind !== 'start',
          selectable: n.kind !== 'start' || fill,
          connectable: Boolean(editor?.onConnect) && n.kind !== 'start',
          ariaLabel: step ? `${data.kind}: ${data.line}` : data.kind,
        };
      }),
    [graph, statuses, problemSteps, selectedId, editor, fill, t, labels, connectorNames, definition],
  );

  // React Flow keeps what it measured on its own node objects; rebuilding them
  // on every poll of a running run dropped those sizes, and with them every
  // edge (edges are placed from measured handles). So the nodes live in React
  // Flow's state, and fresh data is merged into it, keeping the measurements.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<NodeData>>(derived);
  useEffect(() => {
    setNodes((current) => {
      const before = new Map(current.map((n) => [n.id, n] as const));
      return derived.map((n) => {
        const kept = before.get(n.id);
        return kept?.measured ? { ...n, measured: kept.measured } : n;
      });
    });
  }, [derived, setNodes]);

  const byNode = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n] as const)), [graph]);
  // The selected wire: edges are rebuilt from the definition, so React Flow
  // only knows one is selected (and Delete only reaches it) if we say so.
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((e: CanvasEdge) =>
        e.kind === 'flow'
          ? {
              id: e.id,
              source: e.source,
              target: e.target,
              sourceHandle: e.sourceHandle,
              targetHandle: e.targetHandle,
              className: 'wfc-edge-flow',
              // Wires into a top-level step are its dependencies: selectable (and deletable) while editing.
              selectable: Boolean(editor?.onDisconnectFlow) && e.source !== START_ID && byNode.get(e.target)?.parent === null,
              deletable: Boolean(editor?.onDisconnectFlow) && e.source !== START_ID && byNode.get(e.target)?.parent === null,
              selected: e.id === selectedEdge,
              ...(e.arm
                ? {
                    label: t(e.arm === 'yes' ? 'workspace.workflows.canvas.arm.yes' : 'workspace.workflows.canvas.arm.no'),
                    labelStyle: { fontSize: 'var(--fs-5xl)', fontWeight: 600, fill: 'var(--ink-2)' },
                    labelBgStyle: { fill: 'var(--bg)' },
                    labelBgPadding: [6, 3] as [number, number],
                  }
                : {}),
              data: { entry: e.arm ? `${e.source}.${e.arm}` : e.source },
            }
          : {
              id: e.id,
              source: e.source,
              target: e.target,
              sourceHandle: e.sourceHandle,
              targetHandle: e.targetHandle,
              type: 'smoothstep',
              className: 'wfc-edge-data',
              selectable: false,
              hidden: e.adjacent === true,
              data: { fields: e.fields },
            },
      ),
    [graph, editor, t, byNode, selectedEdge],
  );

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n] as const)), [graph]);
  // The canvas is as tall as the drawing at the zoom that fits its width, so
  // the page scrolls past it rather than the drawing shrinking to fit.
  const [boxWidth, setBoxWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBoxWidth(el.clientWidth));
    observer.observe(el);
    setBoxWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);
  const scale = boxWidth > 0 ? Math.min(1, (boxWidth - 64) / Math.max(graph.width, 1)) : 1;
  // Editing keeps the canvas at least as tall as the palette and form beside it.
  const height = Math.round(Math.min(1100, Math.max(editor ? 640 : 360, graph.height * scale + 96)));
  // Full screen: the canvas covers the window below the title bar until Esc or
  // the button. Esc is caught first so it doesn't also cancel the editor.
  const [expanded, setExpanded] = useState(false);
  // Set by each fit: the drawing is wider than the canvas, so say where the rest is.
  const [cutOff, setCutOff] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setExpanded(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [expanded]);
  const selected = selectedId ? byId.get(selectedId) ?? null : null;
  const signature = graph.nodes.map((n) => n.id).join('|');

  const flowApi = useReactFlow();
  const onNodeDragStop = editor?.onNodeDragStop
    ? (_event: unknown, node: Node) => {
        const model = byId.get(node.id);
        const at = flowApi.getInternalNode(node.id)?.internals.positionAbsolute ?? node.position;
        if (model) editor.onNodeDragStop?.(model, { x: at.x + model.width / 2, y: at.y + model.height / 2 });
        // Back to the layout: the new order lays itself out, and a drop that
        // changed nothing must not leave the node where it was let go.
        const home = new Map(derived.map((n) => [n.id, n.position] as const));
        setNodes((current) => current.map((n) => ({ ...n, position: home.get(n.id) ?? n.position })));
      }
    : undefined;

  const drawing = (
    <div className={`wfc${editor ? ' is-editing' : ''}${fill ? ' is-fill' : ''}${expanded ? ' is-expanded' : ''}${className ? ` ${className}` : ''}`}>
      <div className="wfc-canvas" ref={box} style={expanded || fill ? undefined : { height }} aria-label={t('workspace.workflows.canvas.ariaLabel')} role="group">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          nodeTypes={NODE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.25}
          maxZoom={1.75}
          nodesDraggable={Boolean(editor?.onNodeDragStop)}
          nodesConnectable={Boolean(editor?.onConnect)}
          elementsSelectable
          deleteKeyCode={editor?.onDelete ? ['Delete', 'Backspace'] : null}
          onDelete={({ nodes: gone, edges: cut }) => {
            const steps = gone.filter((n) => n.id !== START_ID);
            if (steps.length > 0) {
              steps.forEach((n) => editor?.onDelete?.(n.id));
              return;
            }
            // Only wires were deleted: the step they led to stops waiting for what they came from.
            for (const edge of cut) {
              const entry = (edge.data as { entry?: string } | undefined)?.entry;
              if (entry && entry !== START_ID) editor?.onDisconnectFlow?.(edge.target, entry);
            }
          }}
          onNodeClick={(_e, node) => {
            setSelectedEdge(null);
            select(node.id === START_ID && !fill ? null : node.id);
          }}
          onEdgeClick={(_e, edge) => {
            if (edge.selectable === false) return;
            setSelectedEdge(edge.id);
            select(null);
          }}
          onPaneClick={() => {
            setSelectedEdge(null);
            select(null);
          }}
          onNodeDragStop={onNodeDragStop}
          onConnect={(c: Connection) => {
            if (!c.source || !c.target || c.source === c.target) return;
            // A wire from a bottom dot is "runs after"; from the right-hand dot it carries a value.
            if (c.sourceHandle === 'data-out') editor?.onConnect?.(c.source, c.target);
            else editor?.onConnectFlow?.(c.source, c.target, c.sourceHandle === 'arm-yes' ? 'yes' : c.sourceHandle === 'arm-no' ? 'no' : null);
          }}
          proOptions={{ hideAttribution: true }}
          // Inline, the wheel scrolls the page; filling the page, it pans the
          // drawing. Drag pans too, the buttons and a pinch zoom.
          preventScrolling={fill}
          panOnScroll={fill}
          zoomOnScroll={false}
          zoomOnPinch
        >
          <FitOnChange signature={signature} box={box} fill={fill} onFit={setCutOff} />
          <RevealSelected id={selectedId} box={box} />
          <CanvasControls expanded={expanded} onExpand={() => setExpanded((v) => !v)} onFit={() => setCutOff(fitDrawing(flowApi, box.current, fill))} />
          {cutOff && !expanded ? (
            <Panel position="bottom-left" className="wfc-wide-hint">
              {t('workspace.workflows.canvas.wider')}
            </Panel>
          ) : null}
          {toolbar ? (
            <Panel position="top-left" className="wfc-toolbar">
              {toolbar}
            </Panel>
          ) : null}
        </ReactFlow>
      </div>
      {panel ? (
        <aside className="wfc-inspector wfc-panel" aria-label={t('workspace.workflows.canvas.inspector')}>
          {panel(
            selected,
            selected?.step ? (
              <RunInspector node={selected} definition={definition} graph={graph.edges} run={statuses.get(selected.id)} hasRun={run != null} labels={labels} connectorNames={connectorNames} problems={problemSteps.get(selected.id) ?? []} />
            ) : null,
          )}
        </aside>
      ) : selected || editor ? (
        <aside className="wfc-inspector" aria-label={t('workspace.workflows.canvas.inspector')}>
          {selected && !editor ? (
            <button type="button" className="btn ghost wfc-close" onClick={() => select(null)}>
              {t('workspace.workflows.canvas.closeDetails')}
            </button>
          ) : null}
          {inspector ? inspector(selected) : <RunInspector node={selected} definition={definition} graph={graph.edges} run={statuses.get(selected?.id ?? '')} hasRun={run != null} labels={labels} connectorNames={connectorNames} problems={selected ? problemSteps.get(selected.id) ?? [] : []} />}
        </aside>
      ) : (
        <p className="wfc-hint">{t('workspace.workflows.canvas.selectHint')}</p>
      )}
    </div>
  );
  // Full screen draws into the page's body: a page's layout (a transformed
  // ancestor, a positioned pane) would otherwise keep a fixed box inside it.
  return expanded ? createPortal(drawing, document.body) : drawing;
}

/** What a step reads from and who reads it, as "step id (field)" lines. */
export function wireLines(edges: readonly CanvasEdge[], id: string, dir: 'in' | 'out'): string[] {
  return edges
    .filter((e) => e.kind === 'data' && (dir === 'in' ? e.target === id : e.source === id))
    .map((e) => (dir === 'in' ? `${e.source} (${(e.fields ?? []).join(', ')})` : `${e.target} (${(e.fields ?? []).join(', ')})`));
}

function RunRow({ row, t }: { row: WorkflowRunStep; t: Translate }) {
  const fmt = useFormatters();
  const ms = row.startedAt && row.finishedAt ? new Date(row.finishedAt).getTime() - new Date(row.startedAt).getTime() : null;
  return (
    <details className="wfc-run-row">
      <summary>
        {row.iteration != null ? <span className="wfc-flag">{t('workspace.workflows.canvas.item', { n: row.iteration + 1 })}</span> : null}
        <span className={STATUS_CLASS[row.status] ?? 'wfc-status'}>{t(STATUS_KEY[row.status as Exclude<NodeStatus, 'idle'>] ?? 'workspace.workflows.run.completed')}</span>
        {ms != null && ms >= 0 ? <span className="wf-muted">{fmt.duration(ms)}</span> : null}
      </summary>
      {row.error ? <p className="wf-error">{row.error}</p> : null}
      <p className="wf-io-label">{t('workspace.workflows.runDetail.input')}</p>
      <pre className="wf-io">{JSON.stringify(row.input, null, 2)}</pre>
      {row.output != null ? (
        <>
          <p className="wf-io-label">{t('workspace.workflows.runDetail.output')}</p>
          <pre className="wf-io">{JSON.stringify(row.output, null, 2)}</pre>
        </>
      ) : null}
    </details>
  );
}

function RunInspector({
  node,
  definition,
  graph,
  run,
  hasRun,
  labels,
  connectorNames,
  problems,
}: {
  node: CanvasNode | null;
  definition: WorkflowDefinition;
  graph: readonly CanvasEdge[];
  run: NodeRun | undefined;
  hasRun: boolean;
  labels: InputLabels;
  connectorNames: Record<string, string>;
  problems: string[];
}) {
  const t = useT();
  if (!node?.step) return <p className="wfc-empty">{t('workspace.workflows.canvas.selectHint')}</p>;
  const step: WorkflowStep = node.step;
  const uses = wireLines(graph, node.id, 'in');
  const usedBy = wireLines(graph, node.id, 'out');
  // A loop's own record first, then its iterations, newest last.
  const rows = [...(run?.rows ?? [])].sort((a, b) => (a.iteration ?? -1) - (b.iteration ?? -1));
  return (
    <div className="wfc-inspect">
      <span className="wfc-kind">{t(STEP_TYPE_KEY[step.type])}</span>
      <p className="wfc-inspect-line">{describeStep(step, t, labels, connectorNames, definition.steps)}</p>
      <span className="wf-muted wfc-inspect-id">{node.id}</span>
      {problems.map((p) => (
        <p key={p} className="wf-error">
          {p}
        </p>
      ))}
      {uses.length > 0 ? (
        <div className="wfc-wires">
          <span className="wf-io-label">{t('workspace.workflows.canvas.uses')}</span>
          {uses.map((line) => (
            <span key={line} className="wfc-wire">
              {line}
            </span>
          ))}
        </div>
      ) : null}
      {usedBy.length > 0 ? (
        <div className="wfc-wires">
          <span className="wf-io-label">{t('workspace.workflows.canvas.usedBy')}</span>
          {usedBy.map((line) => (
            <span key={line} className="wfc-wire">
              {line}
            </span>
          ))}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="wfc-runs">{rows.map((row) => <RunRow key={row.id} row={row} t={t} />)}</div>
      ) : (
        <p className="wf-muted">{hasRun ? t('workspace.workflows.canvas.notReached') : t('workspace.workflows.canvas.noRun')}</p>
      )}
    </div>
  );
}

export function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
