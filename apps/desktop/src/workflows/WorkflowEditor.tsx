/// The visual workflow editor: inputs, then the steps as cards.
///
/// Each text field has an "Insert value" menu listing exactly what that step
/// may read (see `valuesAt`): inputs, the run's date, earlier steps' outputs,
/// and inside a "repeat for each" step, the current item's fields. Choosing
/// one puts a chip at the cursor (`ChipField`), so nobody has to know the
/// `{{…}}` syntax underneath.
///
/// Step ids are set when a step is added and never change: other steps refer
/// to them, and renaming would silently break those references. They are
/// shown as a small tag so a reference like `steps.fetch.text` stays readable.
///
/// A summarize step's JSON schema is only editable in the JSON view; the
/// visual editor keeps it as is.

import { STEP_TYPE_KEY } from './stepTypes';
import { CanvasStepsEditor } from './canvas/CanvasStepsEditor';
import { readWorkflowView, writeWorkflowView, type WorkflowViewPref } from '../shell/uiPrefs';
import { useId, useRef, useState, type ReactNode } from 'react';
import { AddStepMenu, ViewToggle } from './AddStepMenu';
import { StartPanel } from './StartPanel';
import { ChipField, type ChipFieldHandle } from './ChipField';
import { useT } from '../i18n';
import type { DataFormat, WorkflowDefinition, WorkflowStep } from '../ipc/contracts';
import {
  AGENT_TOOLS,
  allStepIds,
  CONDITION_TESTS,
  conditionNeedsText,
  DATA_FORMATS,
  DEFAULT_TOP_K,
  MAX_TOP_K,
  RESEARCH_DEPTHS,
  defaultRetries,
  insertStep,
  listSourcesAt,
  MAX_RETRIES,
  MAX_URLS,
  moveStep,
  newStep,
  removeStep,
  stepAt,
  stepTypesFor,
  updateStep,
  withDocumentTarget,
  withOptionalInput,
  withCollection,
  withConditionTest,
  withTopK,
  withOnlyIfChanged,
  withStepModel,
  valuesAt,
  type StepPath,
  type StepType,
  type ValueRef,
} from './editorModel';
import { refLabel } from './refLabel';
import { entryName, runsAfterLine, stepName } from './runsAfter';
import { addDependency, dependencies, entryFor, parseEntry, removeDependency } from './stepGraph';
import { CollectionPicker } from './CollectionPicker';
import { ConnectorStepBody } from './ConnectorStepBody';
import { DocumentPicker } from './DocumentPicker';
import { agentToolText } from './permissionText';
import { ProviderModelsProvider, WorkflowModelRow } from './WorkflowModelRow';

export interface WorkflowDraft {
  name: string;
  description: string;
  definition: WorkflowDefinition;
}


const DATA_FORMAT_KEY: Record<DataFormat, string> = {
  csv: 'workspace.workflows.editor.parseData.csv',
  tsv: 'workspace.workflows.editor.parseData.tsv',
  json: 'workspace.workflows.editor.parseData.json',
};

const RESEARCH_DEPTH_KEY = {
  quick: 'workspace.workflows.editor.research.quick',
  standard: 'workspace.workflows.editor.research.standard',
} as const;

const CONDITION_TEST_KEY = {
  changed: 'workspace.workflows.editor.condition.changed',
  not_empty: 'workspace.workflows.editor.condition.notEmpty',
  empty: 'workspace.workflows.editor.condition.empty',
  contains: 'workspace.workflows.editor.condition.contains',
  not_contains: 'workspace.workflows.editor.condition.notContains',
  equals: 'workspace.workflows.editor.condition.equals',
} as const;

export function WorkflowEditor({
  draft,
  onChange,
  problems,
  notes,
}: {
  draft: WorkflowDraft;
  onChange: (next: WorkflowDraft) => void;
  /** The checker's problems; on the canvas, the steps they name are marked. */
  problems?: readonly string[];
  /** "Still to fill in before you save": shown at the top of the Start panel. */
  notes?: readonly string[];
}) {
  const t = useT();
  const def = draft.definition;
  // Canvas or list, the same remembered choice as the workflow's page.
  const [view, setView] = useState<WorkflowViewPref>(() => readWorkflowView());
  const branchy = def.steps.some((s) => s.type === 'for_each' || s.type === 'condition' || s.type === 'branch' || s.type === 'agent' || s.after !== undefined);
  const stepsView = view === 'auto' ? (branchy ? 'canvas' : 'list') : view;
  const chooseView = (next: 'canvas' | 'list') => {
    setView(next);
    writeWorkflowView(next);
  };
  const setDefinition = (definition: WorkflowDefinition) => onChange({ ...draft, definition });
  const setSteps = (steps: WorkflowStep[]) => setDefinition({ ...def, steps });
  const start = <StartPanel draft={draft} onChange={onChange} notes={notes} />;

  return (
    <ProviderModelsProvider>
      <div className="wf-editor">
        {stepsView === 'canvas' ? (
          <CanvasStepsEditor
            definition={def}
            onChange={setDefinition}
            problems={problems}
            start={start}
            onChooseView={chooseView}
            renderCard={(path) => {
              const step = stepAt(def.steps, path);
              const siblings = path.length === 1 ? def.steps : (stepAt(def.steps, [path[0]]) as Extract<WorkflowStep, { type: 'for_each' }>).steps;
              return step ? (
                <StepCard
                  key={step.id}
                  def={def}
                  step={step}
                  path={path}
                  position={path[path.length - 1]}
                  count={siblings.length}
                  setSteps={setSteps}
                  nestedList={false}
                />
              ) : null;
            }}
          />
        ) : (
          <div className="wfe-list-layout">
            <div className="wfe-list-col">
              <div className="wfe-list-bar">
                <AddStepMenu
                  nested={false}
                  where={t('workspace.workflows.canvas.addEnd')}
                  onPick={(type) => setSteps(insertStep(def.steps, [], newStep(type, allStepIds(def.steps))))}
                />
                <ViewToggle view="list" onChoose={chooseView} />
              </div>
              <StepListEditor def={def} steps={def.steps} parent={[]} setSteps={setSteps} />
            </div>
            <aside className="wfe-start-col" aria-label={t('workspace.workflows.canvas.start')}>
              {start}
            </aside>
          </div>
        )}
      </div>
    </ProviderModelsProvider>
  );
}

function StepListEditor({
  def,
  steps,
  parent,
  setSteps,
}: {
  def: WorkflowDefinition;
  steps: readonly WorkflowStep[];
  parent: StepPath;
  setSteps: (steps: WorkflowStep[]) => void;
}) {
  const t = useT();
  return (
    <>
      <ol className="wf-cards">
        {steps.map((step, index) => (
          <StepCard
            key={step.id}
            def={def}
            step={step}
            path={[...parent, index]}
            position={index}
            count={steps.length}
            setSteps={setSteps}
          />
        ))}
      </ol>
      {parent.length > 0 ? (
      <select
        className="sel wf-add"
        aria-label={parent.length ? t('workspace.workflows.editor.addInside') : t('workspace.workflows.editor.add')}
        value=""
        onChange={(e) => {
          const type = e.target.value as StepType;
          if (!type) return;
          setSteps(insertStep(def.steps, parent, newStep(type, allStepIds(def.steps))));
        }}
      >
        <option value="">{parent.length ? t('workspace.workflows.editor.addInside') : t('workspace.workflows.editor.add')}</option>
        {stepTypesFor(parent.length > 0).map((type) => (
          <option key={type} value={type}>
            {t(STEP_TYPE_KEY[type])}
          </option>
        ))}
      </select>
      ) : null}
    </>
  );
}

function StepCard({
  def,
  step,
  path,
  position,
  count,
  setSteps,
  nestedList = true,
}: {
  def: WorkflowDefinition;
  step: WorkflowStep;
  path: StepPath;
  position: number;
  count: number;
  setSteps: (steps: WorkflowStep[]) => void;
  /** A loop's own steps under its fields; the canvas shows them as nodes instead. */
  nestedList?: boolean;
}) {
  const t = useT();
  const headingId = useId();
  const update = (fn: (s: WorkflowStep) => WorkflowStep) => setSteps(updateStep(def.steps, path, fn));
  const refs = valuesAt(def, path);
  const typeName = t(STEP_TYPE_KEY[step.type]);

  // Only top-level steps may skip when nothing changed (a loop's body repeats).
  const onlyIfChanged =
    path.length === 1 && (step.type === 'notify' || step.type === 'save_artifact') ? (
      <label className="wf-check">
        <input
          type="checkbox"
          checked={step.onlyIfChanged === true}
          onChange={(e) => update((s) => withOnlyIfChanged(s, e.target.checked))}
        />
        {t('workspace.workflows.editor.onlyIfChanged')}
      </label>
    ) : null;

  let body: ReactNode;
  switch (step.type) {
    case 'fetch_page':
      body = (
        <>
          {step.urls.map((url, i) => (
            <div key={i} className="wf-input-row">
              <TextField
                label={t('workspace.workflows.editor.fetch.page', { n: i + 1 })}
                value={url}
                refs={refs}
                onChange={(v) => update((s) => (s.type === 'fetch_page' ? { ...s, urls: s.urls.map((u, j) => (j === i ? v : u)) } : s))}
              />
              {step.urls.length > 1 ? (
                <button
                  type="button"
                  className="btn ghost"
                  aria-label={t('workspace.workflows.editor.fetch.remove', { n: i + 1 })}
                  onClick={() => update((s) => (s.type === 'fetch_page' ? { ...s, urls: s.urls.filter((_, j) => j !== i) } : s))}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
          {step.urls.length < MAX_URLS ? (
            <button
              type="button"
              className="btn ghost wf-add"
              onClick={() => update((s) => (s.type === 'fetch_page' ? { ...s, urls: [...s.urls, ''] } : s))}
            >
              {t('workspace.workflows.editor.fetch.add')}
            </button>
          ) : null}
        </>
      );
      break;
    case 'web_search':
      body = (
        <>
          <TextField
            label={t('workspace.workflows.editor.search.query')}
            value={step.query}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'web_search' ? { ...s, query: v } : s))}
          />
          <label className="wf-field wf-narrow">
            <span>{t('workspace.workflows.editor.search.maxResults')}</span>
            <input
              className="mem-input"
              type="number"
              min={1}
              max={20}
              value={step.maxResults ?? 5}
              onChange={(e) =>
                update((s) =>
                  s.type === 'web_search' ? { ...s, maxResults: Math.max(1, Math.min(20, Number(e.target.value) || 1)) } : s,
                )
              }
            />
          </label>
        </>
      );
      break;
    case 'read_file':
      body = (
        <>
          <TextField
            label={t('workspace.workflows.editor.readFile.path')}
            value={step.path}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'read_file' ? { ...s, path: v } : s))}
          />
          {def.folder ? null : <p className="wf-muted">{t('workspace.workflows.editor.readFile.noFolder')}</p>}
        </>
      );
      break;
    case 'parse_data':
      body = (
        <>
          <TextField
            multiline
            label={t('workspace.workflows.editor.parseData.input')}
            value={step.input}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'parse_data' ? { ...s, input: v } : s))}
          />
          <label className="wf-field wf-narrow">
            <span>{t('workspace.workflows.editor.parseData.format')}</span>
            <select
              className="sel"
              value={step.format}
              onChange={(e) =>
                update((s) => (s.type === 'parse_data' ? { ...s, format: e.target.value as DataFormat } : s))
              }
            >
              {DATA_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {t(DATA_FORMAT_KEY[format])}
                </option>
              ))}
            </select>
          </label>
        </>
      );
      break;
    case 'research':
      body = (
        <>
          <TextField
            label={t('workspace.workflows.editor.research.question')}
            value={step.question}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'research' ? { ...s, question: v } : s))}
          />
          <label className="wf-field wf-narrow">
            <span>{t('workspace.workflows.editor.research.depth')}</span>
            <select
              className="sel"
              value={step.depth}
              onChange={(e) =>
                update((s) => (s.type === 'research' ? { ...s, depth: e.target.value as typeof step.depth } : s))
              }
            >
              {RESEARCH_DEPTHS.map((depth) => (
                <option key={depth} value={depth}>
                  {t(RESEARCH_DEPTH_KEY[depth])}
                </option>
              ))}
            </select>
          </label>
          <p className="wf-muted">{t('workspace.workflows.editor.research.hint')}</p>
          <WorkflowModelRow
            kind="step"
            idPrefix={`wf-model-${step.id}`}
            model={step.model}
            onChange={(model) => update((s) => withStepModel(s, model))}
          />
        </>
      );
      break;
    case 'search_documents':
      body = (
        <>
          <CollectionPicker
            value={step.collections}
            onToggle={(id, on) => update((s) => withCollection(s, id, on))}
          />
          <TextField
            multiline
            label={t('workspace.workflows.editor.searchDocs.query')}
            value={step.query}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'search_documents' ? { ...s, query: v } : s))}
          />
          <label className="wf-field wf-narrow">
            <span>{t('workspace.workflows.editor.searchDocs.topK')}</span>
            <input
              className="mem-input"
              type="number"
              min={1}
              max={MAX_TOP_K}
              value={step.topK ?? DEFAULT_TOP_K}
              onChange={(e) => update((s) => withTopK(s, Number(e.target.value)))}
            />
          </label>
        </>
      );
      break;
    case 'connector_tool':
      body = (
        <ConnectorStepBody
          step={step}
          update={update}
          renderText={(p) => <TextField label={p.label} value={p.value} refs={refs} onChange={p.onChange} multiline={p.multiline} />}
        />
      );
      break;
    case 'summarize':
      body = (
        <>
          <TextField
            multiline
            label={t('workspace.workflows.editor.summarize.prompt')}
            value={step.prompt}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'summarize' ? { ...s, prompt: v } : s))}
          />
          <TextField
            multiline
            label={t('workspace.workflows.editor.summarize.input')}
            value={step.input}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'summarize' ? { ...s, input: v } : s))}
          />
          {step.schema ? <p className="wf-muted">{t('workspace.workflows.editor.summarize.schemaKept')}</p> : null}
          <WorkflowModelRow
            kind="step"
            idPrefix={`wf-model-${step.id}`}
            model={step.model}
            onChange={(model) => update((s) => (s.type === 'summarize' ? withStepModel(s, model) : s))}
          />
        </>
      );
      break;
    case 'template':
      body = (
        <TextField
          multiline
          label={t('workspace.workflows.editor.template.text')}
          value={step.template}
          refs={refs}
          onChange={(v) => update((s) => (s.type === 'template' ? { ...s, template: v } : s))}
        />
      );
      break;
    case 'for_each': {
      const sources = listSourcesAt(def, path);
      const known = sources.some((s) => s.path === step.items);
      body = (
        <>
          <label className="wf-field">
            <span>{t('workspace.workflows.editor.forEach.items')}</span>
            <select
              className="sel"
              value={step.items}
              onChange={(e) => update((s) => (s.type === 'for_each' ? { ...s, items: e.target.value } : s))}
            >
              <option value="">{t('workspace.workflows.editor.forEach.choose')}</option>
              {sources.map((source) => (
                <option key={source.path} value={source.path}>
                  {refLabel(source, t)}
                </option>
              ))}
              {step.items && !known ? <option value={step.items}>{step.items}</option> : null}
            </select>
          </label>
          {nestedList ? (
            <div className="wf-nested">
              <StepListEditor def={def} steps={step.steps} parent={path} setSteps={setSteps} />
            </div>
          ) : null}
        </>
      );
      break;
    }
    case 'save_artifact':
      body = (
        <>
          <TextField
            label={t('workspace.workflows.editor.save.title')}
            value={step.title}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'save_artifact' ? { ...s, title: v } : s))}
          />
          <TextField
            multiline
            label={t('workspace.workflows.editor.save.content')}
            value={step.content}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'save_artifact' ? { ...s, content: v } : s))}
          />
          <div className="wf-input-row">
            <label className="wf-field">
              <span>{t('workspace.workflows.editor.save.format')}</span>
              <select
                className="sel"
                value={step.format ?? 'markdown'}
                onChange={(e) =>
                  update((s) => (s.type === 'save_artifact' ? { ...s, format: e.target.value as 'markdown' | 'html' } : s))
                }
              >
                <option value="markdown">{t('workspace.workflows.editor.save.markdown')}</option>
                <option value="html">{t('workspace.workflows.editor.save.html')}</option>
              </select>
            </label>
            <label className="wf-field">
              <span>{t('workspace.workflows.editor.save.mode')}</span>
              <select
                className="sel"
                value={step.mode ?? 'update'}
                onChange={(e) =>
                  update((s) => (s.type === 'save_artifact' ? { ...s, mode: e.target.value as 'update' | 'create' } : s))
                }
              >
                <option value="update">{t('workspace.workflows.editor.save.update')}</option>
                <option value="create">{t('workspace.workflows.editor.save.create')}</option>
              </select>
            </label>
          </div>
          {onlyIfChanged}
        </>
      );
      break;
    case 'export_file':
      body = (
        <>
          <TextField
            label={t('workspace.workflows.editor.export.name')}
            value={step.name}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'export_file' ? { ...s, name: v } : s))}
          />
          <TextField
            multiline
            label={t('workspace.workflows.editor.export.content')}
            value={step.content}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'export_file' ? { ...s, content: v } : s))}
          />
          <p className="wf-muted">{t('workspace.workflows.editor.export.hint')}</p>
        </>
      );
      break;
    case 'save_memory':
      body = (
        <>
          <TextField
            multiline
            label={t('workspace.workflows.editor.memory.text')}
            value={step.text}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'save_memory' ? { ...s, text: v } : s))}
          />
          <p className="wf-muted">{t('workspace.workflows.editor.memory.hint')}</p>
        </>
      );
      break;
    case 'agent':
      body = (
        <>
          <TextField
            label={t('workspace.workflows.editor.summarize.prompt')}
            value={step.prompt}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'agent' ? { ...s, prompt: v } : s))}
          />
          <TextField
            multiline
            label={t('workspace.workflows.editor.summarize.input')}
            value={step.input ?? ''}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'agent' ? { ...s, input: v } : s))}
          />
          <fieldset className="wf-tools">
            <legend>{t('workspace.workflows.editor.agent.tools')}</legend>
            {AGENT_TOOLS.map((tool) => (
              <label key={tool} className="wf-check">
                <input
                  type="checkbox"
                  checked={(step.tools ?? []).includes(tool)}
                  onChange={(e) =>
                    update((s) => {
                      if (s.type !== 'agent') return s;
                      const others = (s.tools ?? []).filter((x) => x !== tool);
                      // Kept in the catalog's order, so the stored list is stable.
                      const next = e.target.checked ? [...others, tool] : others;
                      return { ...s, tools: AGENT_TOOLS.filter((x) => next.includes(x)) };
                    })
                  }
                />
                {agentToolText(tool, t)}
              </label>
            ))}
          </fieldset>
          <p className="wf-muted">{t('workspace.workflows.editor.agent.hint')}</p>
          <WorkflowModelRow
            kind="step"
            idPrefix={`wf-model-${step.id}`}
            model={step.model}
            onChange={(model) => update((s) => (s.type === 'agent' ? withStepModel(s, model) : s))}
          />
        </>
      );
      break;
    case 'edit_deck':
    case 'edit_draft':
      body = (
        <>
          <DocumentPicker
            kind={step.type === 'edit_deck' ? 'deck' : 'draft'}
            value={step.type === 'edit_deck' ? step.deck : step.draft}
            onChange={(id) => update((s) => withDocumentTarget(s, id))}
          />
          <TextField
            multiline
            label={t('workspace.workflows.editor.editDoc.instructions')}
            value={step.instructions}
            refs={refs}
            onChange={(v) =>
              update((s) => (s.type === 'edit_deck' || s.type === 'edit_draft' ? { ...s, instructions: v } : s))
            }
          />
          <TextField
            multiline
            label={t('workspace.workflows.editor.summarize.input')}
            value={step.input ?? ''}
            refs={refs}
            onChange={(v) => update((s) => withOptionalInput(s, v))}
          />
          <p className="wf-muted">{t('workspace.workflows.editor.editDoc.hint')}</p>
          <WorkflowModelRow
            kind="step"
            idPrefix={`wf-model-${step.id}`}
            model={step.model}
            onChange={(model) => update((s) => withStepModel(s, model))}
          />
        </>
      );
      break;
    case 'ask':
      body = (
        <>
          <TextField
            label={t('workspace.workflows.editor.ask.question')}
            value={step.question}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'ask' ? { ...s, question: v } : s))}
          />
          <label className="wf-field">
            <span>{t('workspace.workflows.editor.ask.choices')}</span>
            <textarea
              className="mem-input"
              rows={3}
              value={(step.choices ?? []).join('\n')}
              onChange={(e) =>
                update((s) => (s.type === 'ask' ? { ...s, choices: e.target.value.split('\n') } : s))
              }
              // Blank lines only while typing; they go when the box is left.
              onBlur={() =>
                update((s) =>
                  s.type === 'ask' ? { ...s, choices: (s.choices ?? []).map((c) => c.trim()).filter(Boolean) } : s,
                )
              }
            />
          </label>
          <label className="wf-field">
            <span>{t('workspace.workflows.editor.ask.default')}</span>
            <input
              className="mem-input"
              value={step.default ?? ''}
              onChange={(e) =>
                update((s) => (s.type === 'ask' ? { ...s, default: e.target.value.trim() ? e.target.value : null } : s))
              }
            />
          </label>
        </>
      );
      break;
    case 'notify':
      body = (
        <>
          <TextField
            label={t('workspace.workflows.editor.notify.title')}
            value={step.title}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'notify' ? { ...s, title: v } : s))}
          />
          <TextField
            multiline
            label={t('workspace.workflows.editor.notify.body')}
            value={step.body ?? ''}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'notify' ? { ...s, body: v } : s))}
          />
          {onlyIfChanged}
        </>
      );
      break;
    case 'condition':
      body = (
        <>
          <TextField
            label={t('workspace.workflows.editor.condition.value')}
            value={step.value}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'condition' ? { ...s, value: v } : s))}
          />
          <label className="wf-field">
            <span>{t('workspace.workflows.editor.condition.is')}</span>
            <select
              className="sel"
              value={step.is}
              onChange={(e) =>
                update((s) => withConditionTest(s, e.target.value as (typeof CONDITION_TESTS)[number]))
              }
            >
              {CONDITION_TESTS.map((test) => (
                <option key={test} value={test}>
                  {t(CONDITION_TEST_KEY[test])}
                </option>
              ))}
            </select>
          </label>
          {conditionNeedsText(step.is) ? (
            <TextField
              label={t('workspace.workflows.editor.condition.text')}
              value={step.text ?? ''}
              refs={refs}
              onChange={(v) => update((s) => (s.type === 'condition' ? { ...s, text: v } : s))}
            />
          ) : null}
        </>
      );
      break;
    case 'branch':
      body = (
        <>
          <TextField
            label={t('workspace.workflows.editor.condition.value')}
            value={step.value}
            refs={refs}
            onChange={(v) => update((s) => (s.type === 'branch' ? { ...s, value: v } : s))}
          />
          <label className="wf-field">
            <span>{t('workspace.workflows.editor.branch.is')}</span>
            <select
              className="sel"
              value={step.is}
              onChange={(e) =>
                update((s) => withConditionTest(s, e.target.value as (typeof CONDITION_TESTS)[number]))
              }
            >
              {CONDITION_TESTS.map((test) => (
                <option key={test} value={test}>
                  {t(CONDITION_TEST_KEY[test])}
                </option>
              ))}
            </select>
          </label>
          {conditionNeedsText(step.is) ? (
            <TextField
              label={t('workspace.workflows.editor.condition.text')}
              value={step.text ?? ''}
              refs={refs}
              onChange={(v) => update((s) => (s.type === 'branch' ? { ...s, text: v } : s))}
            />
          ) : null}
          <p className="wf-muted">{t('workspace.workflows.editor.branch.hint')}</p>
        </>
      );
      break;
  }
  const usualRetries = defaultRetries(step.type);
  const retriesNow = step.retries ?? usualRetries ?? 0;
  const failure =
    step.onError === 'skip'
      ? t('workspace.workflows.editor.failure.skip')
      : retriesNow > 0
        ? t('workspace.workflows.editor.failure.retry', { count: retriesNow })
        : t('workspace.workflows.editor.failure.stop');
  const failureSettings = (
    <details className="wfe-failure">
      <summary>
        {t('workspace.workflows.editor.failure.title')}
        {' '}
        <span className="wfe-failure-now">{failure}</span>
      </summary>
      <div className="wfe-failure-body">
        {usualRetries !== null ? (
          <label className="wf-field wf-retries">
            <span>{t('workspace.workflows.editor.retries')}</span>
            <select
              className="sel"
              value={step.retries ?? usualRetries}
              onChange={(e) => {
                const n = Number(e.target.value);
                // The usual number stays unwritten, so the stored workflow keeps
                // following the default.
                update((s) => ({ ...s, retries: n === usualRetries ? undefined : n }));
              }}
            >
              {Array.from({ length: MAX_RETRIES + 1 }, (_, n) => (
                <option key={n} value={n}>
                  {t('workspace.workflows.editor.retriesCount', { count: n })}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="wf-check">
          <input
            type="checkbox"
            checked={step.onError === 'skip'}
            onChange={(e) => update((s) => ({ ...s, onError: e.target.checked ? 'skip' : 'fail' }))}
          />
          {t('workspace.workflows.editor.keepGoing')}
        </label>
      </div>
    </details>
  );

  const runsAfter = path.length === 1 ? <RunsAfterControl def={def} step={step} index={path[0]} setSteps={setSteps} /> : null;

  // On the canvas the side panel has its own header, so the card is just the form.
  if (!nestedList) {
    return (
      <section className="wfe-form" aria-label={typeName}>
        <div className="wf-card-body">{body}</div>
        {runsAfter}
        {failureSettings}
      </section>
    );
  }

  return (
    <li className="wf-card" aria-labelledby={headingId}>
      <header className="wf-card-head">
        <span className="wf-card-title" id={headingId}>
          {t('workspace.workflows.editor.cardTitle', { n: position + 1, type: typeName })}
        </span>
        <code className="wf-card-id">{step.id}</code>
        <span className="wf-card-actions">
          <button
            type="button"
            className="btn ghost"
            aria-label={t('workspace.workflows.editor.moveUp', { type: typeName, n: position + 1 })}
            disabled={position === 0}
            onClick={() => setSteps(moveStep(def.steps, path, -1))}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn ghost"
            aria-label={t('workspace.workflows.editor.moveDown', { type: typeName, n: position + 1 })}
            disabled={position === count - 1}
            onClick={() => setSteps(moveStep(def.steps, path, 1))}
          >
            ↓
          </button>
          <button
            type="button"
            className="btn ghost"
            aria-label={t('workspace.workflows.editor.remove', { type: typeName, n: position + 1 })}
            onClick={() => setSteps(removeStep(def.steps, path))}
          >
            ×
          </button>
        </span>
      </header>
      {path.length === 1 && runsAfterLine(def.steps, path[0], t) ? <p className="wf-muted">{runsAfterLine(def.steps, path[0], t)}</p> : null}
      <div className="wf-card-body">{body}</div>
      {runsAfter}
      {failureSettings}
    </li>
  );
}

/// "Runs after": which earlier steps a top-level step waits for. The default
/// is the step before; ticking several makes it wait for all of them (a join),
/// and two steps that wait for the same step run side by side. A branch offers
/// its yes and no sides too.
function RunsAfterControl({
  def,
  step,
  index,
  setSteps,
}: {
  def: WorkflowDefinition;
  step: WorkflowStep;
  index: number;
  setSteps: (steps: WorkflowStep[]) => void;
}) {
  const t = useT();
  if (index === 0) return null;
  const steps = def.steps;
  const entries = dependencies(steps).get(step.id) ?? [];
  const isDefault = entries.length === 1 && entries[0] === steps[index - 1].id;
  const now = isDefault
    ? t('workspace.workflows.editor.runsAfter.previous')
    : entries.length === 0
      ? t('workspace.workflows.editor.runsAfter.start')
      : entries.map((e) => entryName(steps, e, t)).join(', ');
  const options = steps.slice(0, index).flatMap((earlier) =>
    earlier.type === 'branch'
      ? [entryFor(earlier.id, null), entryFor(earlier.id, 'yes'), entryFor(earlier.id, 'no')]
      : [entryFor(earlier.id, null)],
  );
  return (
    <details className="wfe-failure">
      <summary>
        {t('workspace.workflows.editor.runsAfter.title')}{' '}
        <span className="wfe-failure-now">{now}</span>
      </summary>
      <fieldset className="wfe-failure-body wf-tools">
        <legend>{t('workspace.workflows.editor.runsAfter.title')}</legend>
        {options.map((entry) => (
          <label key={entry} className="wf-check">
            <input
              type="checkbox"
              checked={entries.includes(entry)}
              onChange={(e) =>
                setSteps(e.target.checked ? addDependency(steps, step.id, entry) : removeDependency(steps, step.id, entry))
              }
            />
            {parseEntry(entry).arm ? entryName(steps, entry, t) : stepName(steps, entry, t)}
          </label>
        ))}
        <p className="wf-muted">{t('workspace.workflows.editor.runsAfter.hint')}</p>
      </fieldset>
    </details>
  );
}

/// A text input (or textarea) with an "Insert value" menu that puts
/// `{{path}}` at the cursor.
function TextField({
  label,
  value,
  refs,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  refs: ValueRef[];
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  const t = useT();
  const labelId = useId();
  const fieldRef = useRef<ChipFieldHandle>(null);
  const labelFor = (path: string) => {
    const found = refs.find((r) => r.path === path);
    return found ? refLabel(found, t) : null;
  };
  const groups: { key: string; refs: ValueRef[] }[] = [
    { key: 'workspace.workflows.editor.insert.inputs', refs: refs.filter((r) => r.source.kind === 'input' || r.source.kind === 'run') },
    { key: 'workspace.workflows.editor.insert.trigger', refs: refs.filter((r) => r.source.kind === 'trigger') },
    { key: 'workspace.workflows.editor.insert.item', refs: refs.filter((r) => r.source.kind === 'item') },
    { key: 'workspace.workflows.editor.insert.steps', refs: refs.filter((r) => r.source.kind === 'step') },
  ].filter((g) => g.refs.length > 0);

  return (
    <div className="wf-field wf-text-field">
      <div className="wf-field">
        <span id={labelId}>{label}</span>
        <ChipField
          ref={fieldRef}
          value={value}
          onChange={onChange}
          labelFor={labelFor}
          removeLabel={(chip) => t('workspace.workflows.editor.chip.remove', { value: chip })}
          multiline={multiline}
          labelledBy={labelId}
        />
      </div>
      <select
        className="sel wf-insert wfe-insert"
        aria-label={t('workspace.workflows.editor.insert.label', { field: label })}
        value=""
        onChange={(e) => {
          if (e.target.value) fieldRef.current?.insert(e.target.value);
        }}
      >
        <option value="">{t('workspace.workflows.editor.insert.placeholder')}</option>
        {groups.map((group) => (
          <optgroup key={group.key} label={t(group.key)}>
            {group.refs.map((ref) => (
              <option key={ref.path} value={ref.path}>
                {refLabel(ref, t)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
