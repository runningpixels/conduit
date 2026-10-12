/// Editing a workflow's steps on the canvas: a palette adds a step after the
/// selected one (or inside a selected loop), dragging a step moves it (into
/// and out of loops too), the selected step's form opens beside it, Delete
/// removes it, and a wire drawn from one step to a later one puts that
/// step's output into a field of the later one.
///
/// All of it changes the definition through `canvasEdit.ts`; the canvas then
/// lays itself out again. The step form is the editor's own, passed in as
/// `renderCard`, so both views edit a step the same way.

import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useT } from '../../i18n';
import type { WorkflowDefinition } from '../../ipc/contracts';
import { refLabel } from '../refLabel';
import { STEP_TYPE_KEY } from '../stepTypes';
import { stepTypesFor, type StepPath, type StepType } from '../editorModel';
import { buildCanvas, type CanvasNode } from './canvasModel';
import { addPlace, addStep, connectReference, deleteStep, dropPlace, moveStepTo, pathOf, wireChoices, type TemplateField } from './canvasEdit';
import { WorkflowCanvas, type CanvasEditor } from './WorkflowCanvas';
import type { InputLabels } from '../describeStep';
import type { ValueRef } from '../editorModel';

type Wire =
  | { source: string; target: string; ok: true; outputs: ValueRef[]; fields: TemplateField[]; output: string; field: string }
  | { source: string; target: string; ok: false; reason: 'later' | 'nothing' };

export interface CanvasStepsEditorProps {
  definition: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
  /** The step form for the step at `path` (the editor's own card). */
  renderCard: (path: StepPath) => ReactNode;
  problems?: readonly string[];
  labels?: InputLabels;
}

export function CanvasStepsEditor({ definition, onChange, renderCard, problems, labels }: CanvasStepsEditorProps) {
  const t = useT();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [wire, setWire] = useState<Wire | null>(null);
  const graph = useMemo(() => buildCanvas(definition), [definition]);
  // Inputs by their names, so a step reads "Fetch 1 page: [Page]", not the template.
  const inputLabels = useMemo(
    () => labels ?? Object.fromEntries((definition.inputs ?? []).map((i) => [i.id, i.label])),
    [labels, definition.inputs],
  );

  // A selection that no longer exists (deleted, or undone in the list view) is dropped.
  const selected = selectedId && pathOf(definition.steps, selectedId) ? selectedId : null;
  const place = addPlace(definition, selected);

  const add = useCallback(
    (type: StepType) => {
      const { def, id } = addStep(definition, type, selected);
      onChange(def);
      setSelectedId(id);
    },
    [definition, selected, onChange],
  );

  const palette = (
    <div className="wfc-palette" role="group" aria-label={t('workspace.workflows.canvas.paletteLabel')}>
      <span className="wfc-palette-where">
        {selected
          ? place.nested && definition.steps.find((s) => s.id === selected)?.type === 'for_each'
            ? t('workspace.workflows.canvas.addInside')
            : t('workspace.workflows.canvas.addAfter', { step: selected })
          : t('workspace.workflows.canvas.addEnd')}
      </span>
      <div className="wfc-palette-items">
        {stepTypesFor(place.nested).map((type) => (
          <button key={type} type="button" className="wfc-palette-item" onClick={() => add(type)}>
            {t(STEP_TYPE_KEY[type])}
          </button>
        ))}
      </div>
    </div>
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
      onDelete: (id: string) => {
        onChange(deleteStep(definition, id));
        setSelectedId(null);
      },
    }),
    [graph, definition, onChange],
  );

  // The side column: the palette on top, then the selected step's form.
  const inspector = (node: CanvasNode | null) => (
    <>
      {palette}
      {node?.path ? <ol className="wf-cards wfc-card">{renderCard(node.path)}</ol> : <p className="wfc-empty">{t('workspace.workflows.canvas.selectToEdit')}</p>}
    </>
  );

  const insertWire = () => {
    if (!wire || !wire.ok) return;
    const field = wire.fields.find((f) => f.key === wire.field);
    if (!field) return;
    onChange(connectReference(definition, wire.target, field, wire.output));
    setSelectedId(wire.target);
    setWire(null);
  };

  return (
    <div className="wfc-editor">
      <p className="wf-muted wfc-edit-hint">{t('workspace.workflows.canvas.editHint')}</p>
      <WorkflowCanvas
        definition={definition}
        labels={inputLabels}
        problems={problems}
        selectedId={selected}
        onSelect={setSelectedId}
        inspector={inspector}
        editor={editor}
      />
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
