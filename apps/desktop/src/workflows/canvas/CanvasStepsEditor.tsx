/// Editing a workflow's steps on the canvas. A toolbar over the canvas adds a
/// step after the selected one (or inside a selected loop); dragging a step
/// moves it (into and out of loops too); the side column shows the Start panel
/// (nothing or the start node selected) or the selected step's form; Delete
/// removes the step, and a wire drawn from one step to a later one puts that
/// step's output into a field of the later one.
///
/// All of it changes the definition through `canvasEdit.ts`; the canvas then
/// lays itself out again. The step form and the Start panel are the editor's
/// own, passed in, so both views edit the same way.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { WorkflowDefinition } from '../../ipc/contracts';
import { refLabel } from '../refLabel';
import { STEP_TYPE_KEY } from '../stepTypes';
import { helperNames, type StepPath, type StepType } from '../editorModel';
import { START_ID, buildCanvas, type CanvasNode } from './canvasModel';
import { addPlace, addStep, connectFlow, connectReference, deleteStep, disconnectFlow, dropPlace, flowChoices, moveStepTo, pathOf, wireChoices, type TemplateField } from './canvasEdit';
import { WorkflowCanvas, type CanvasEditor } from './WorkflowCanvas';
import { describeStep, stepLabels, type InputLabels } from '../describeStep';
import { useConnectorNames } from '../useConnectorNames';
import { AddStepMenu, ViewToggle } from '../AddStepMenu';
import type { ValueRef } from '../editorModel';
import type { Arm } from '../stepGraph';

type Wire =
  | { source: string; target: string; ok: true; outputs: ValueRef[]; fields: TemplateField[]; output: string; field: string }
  | { source: string; target: string; ok: false; reason: 'later' | 'nothing' };

/** A "runs after" wire that needs an answer or an apology: which side of a branch, or why not. */
type FlowWire = { source: string; target: string } & ({ ask: true } | { ask: false; reason: 'later' | 'nested' });

export interface CanvasStepsEditorProps {
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
  /** The step form for the step at `path` (the editor's own card). */
  renderCard: (path: StepPath) => ReactNode;
  /** The Start panel, shown when nothing or the start node is selected. */
  start: ReactNode;
  /** Switch to the list view (the toggle in the toolbar). */
  onChooseView: (next: 'canvas' | 'list') => void;
  problems?: readonly string[];
  labels?: InputLabels;
}

export function CanvasStepsEditor({ definition, onChange, renderCard, start, onChooseView, problems, labels }: CanvasStepsEditorProps) {
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wire, setWire] = useState<Wire | null>(null);
  const [flow, setFlow] = useState<FlowWire | null>(null);
  const graph = useMemo(() => buildCanvas(definition), [definition]);
  // Inputs by their names, so a step reads "Fetch 1 page: [Page]", not the template.
  const inputLabels = useMemo(
    () => labels ?? stepLabels(definition),
    [labels, definition],
  );

  // A selection that no longer exists (deleted, or undone in the list view) is dropped.
  const selected = selectedId && pathOf(definition.steps, selectedId) ? selectedId : null;
  const highlighted = selectedId === START_ID ? START_ID : selected;
  const place = addPlace(definition, selected);
  const connectorNames = useConnectorNames(definition.steps);
  const flat = definition.steps.flatMap((s) => (s.type === 'for_each' ? [s, ...s.steps] : [s]));
  const selectedStep = selected ? flat.find((s) => s.id === selected) : undefined;
  const summary = (id: string) => {
    const step = flat.find((s) => s.id === id);
    return step ? describeStep(step, t, inputLabels, connectorNames, definition.steps, helperNames(definition)) : id;
  };

  const add = useCallback(
    (type: StepType) => {
      const { def, id } = addStep(definition, type, selected);
      onChange(def);
      setSelectedId(id);
    },
    [definition, selected, onChange],
  );

  const where = selected
    ? place.nested && selectedStep?.type === 'for_each'
      ? t('workspace.workflows.canvas.addInside')
      : t('workspace.workflows.canvas.addAfter', { step: summary(selected) })
    : t('workspace.workflows.canvas.addEnd');
  const toolbar = (
    <>
      <AddStepMenu nested={place.nested} where={where} onPick={add} />
      <ViewToggle view="canvas" onChoose={onChooseView} />
    </>
  );

  const editor: CanvasEditor = useMemo(
    () => ({
      onNodeDragStop: (node: CanvasNode, center: { x: number; y: number }) => {
        const to = dropPlace(graph, node.id, center, node.kind === 'loop');
        const next = moveStepTo(definition, node.id, to);
        if (next !== definition) onChange(next);
      },
      onConnect: (source: string, target: string) => {
        const choices = wireChoices(definition, source, target);
        setWire(
          choices.ok
            ? { source, target, ok: true, outputs: choices.outputs, fields: choices.fields, output: choices.outputs[0].path, field: choices.fields[0].key }
            : { source, target, ok: false, reason: choices.reason },
        );
      },
      onConnectFlow: (source: string, target: string, arm: Arm | null) => {
        const choice = flowChoices(definition, source, target);
        if (!choice.ok) return setFlow({ source, target, ask: false, reason: choice.reason });
        if (choice.branch && !arm) return setFlow({ source, target, ask: true });
        const next = connectFlow(definition, source, target, arm);
        if (next !== definition) onChange(next);
        setSelectedId(target);
      },
      onDisconnectFlow: (target: string, entry: string) => {
        const next = disconnectFlow(definition, target, entry);
        if (next !== definition) onChange(next);
      },
      onDelete: (id: string) => {
        onChange(deleteStep(definition, id));
        setSelectedId(null);
      },
    }),
    [graph, definition, onChange],
  );

  // The side column: the Start panel, or the selected step's header and form.
  const panel = (node: CanvasNode | null) => {
    if (!node?.path || !node.step) return start;
    const step = node.step;
    return (
      <div className="wfe-step-panel">
        <header className="wfe-step-head">
          <div className="wfe-step-line">
            <span className="wfe-kicker">
              {t('workspace.workflows.editor.panel.stepKind', { n: node.path.map((i) => i + 1).join('.'), kind: t(STEP_TYPE_KEY[step.type]) })}
            </span>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                onChange(deleteStep(definition, step.id));
                setSelectedId(null);
              }}
            >
              {t('workspace.workflows.editor.panel.delete')}
            </button>
          </div>
          <h2 className="wfe-title wfe-clamp">{summary(step.id)}</h2>
        </header>
        {renderCard(node.path)}
      </div>
    );
  };

  const insertWire = () => {
    if (!wire || !wire.ok) return;
    const field = wire.fields.find((f) => f.key === wire.field);
    if (!field) return;
    onChange(connectReference(definition, wire.target, field, wire.output));
    setSelectedId(wire.target);
    setWire(null);
  };

  const chooseArm = (arm: Arm) => {
    if (!flow || !flow.ask) return;
    onChange(connectFlow(definition, flow.source, flow.target, arm));
    setSelectedId(flow.target);
    setFlow(null);
  };

  return (
    <div className="wfc-editor wfe-canvas-host">
      <WorkflowCanvas
        definition={definition}
        labels={inputLabels}
        problems={problems}
        selectedId={highlighted}
        onSelect={setSelectedId}
        panel={panel}
        toolbar={toolbar}
        editor={editor}
      />
      {flow ? (
        <div
          className="cu-dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setFlow(null);
          }}
        >
          <div
            className="cu-dialog wfc-wire-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('workspace.workflows.canvas.flow.title', { target: flow.target })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setFlow(null);
              }
            }}
          >
            <h2 className="cu-dialog-title">{t('workspace.workflows.canvas.flow.title', { target: flow.target })}</h2>
            <div className="cu-dialog-body">
              {flow.ask
                ? t('workspace.workflows.canvas.flow.which', { source: flow.source })
                : flow.reason === 'later'
                  ? t('workspace.workflows.canvas.flow.later', { source: flow.source, target: flow.target })
                  : t('workspace.workflows.canvas.flow.nested')}
            </div>
            <div className="cu-dialog-actions">
              <button type="button" className="btn ghost" autoFocus={!flow.ask} onClick={() => setFlow(null)}>
                {flow.ask ? t('common.actions.cancel') : t('workspace.workflows.canvas.wire.ok')}
              </button>
              {flow.ask ? (
                <>
                  <button type="button" className="btn primary" autoFocus onClick={() => chooseArm('yes')}>
                    {t('workspace.workflows.canvas.flow.yes')}
                  </button>
                  <button type="button" className="btn primary" onClick={() => chooseArm('no')}>
                    {t('workspace.workflows.canvas.flow.no')}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
      {wire ? (
        <div
          className="cu-dialog-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setWire(null);
          }}
        >
          <div
            className="cu-dialog wfc-wire-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t('workspace.workflows.canvas.wire.title', { step: wire.source })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setWire(null);
              }
            }}
          >
            <h2 className="cu-dialog-title">{t('workspace.workflows.canvas.wire.title', { step: wire.source })}</h2>
            {wire.ok ? (
              <>
                <label className="wf-field">
                  <span>{t('workspace.workflows.canvas.wire.value')}</span>
                  <select className="sel" autoFocus value={wire.output} onChange={(e) => setWire({ ...wire, output: e.target.value })}>
                    {wire.outputs.map((o) => (
                      <option key={o.path} value={o.path}>
                        {refLabel(o, t)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="wf-field">
                  <span>{t('workspace.workflows.canvas.wire.field', { step: wire.target })}</span>
                  <select className="sel" value={wire.field} onChange={(e) => setWire({ ...wire, field: e.target.value })}>
                    {wire.fields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {t(f.labelId)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <div className="cu-dialog-body">
                {wire.reason === 'later'
                  ? t('workspace.workflows.canvas.wire.later', { source: wire.source, target: wire.target })
                  : t('workspace.workflows.canvas.wire.nothing', { source: wire.source, target: wire.target })}
              </div>
            )}
            <div className="cu-dialog-actions">
              <button type="button" className="btn ghost" onClick={() => setWire(null)}>
                {wire.ok ? t('common.actions.cancel') : t('workspace.workflows.canvas.wire.ok')}
              </button>
              {wire.ok ? (
                <button type="button" className="btn primary" onClick={insertWire}>
                  {t('workspace.workflows.canvas.wire.insert')}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
