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

import { useId, useRef, type ReactNode } from 'react';
import { ChipField, type ChipFieldHandle } from './ChipField';
import { useT, type Translate } from '../i18n';
import type { WorkflowDefinition, WorkflowInput, WorkflowStep } from '../ipc/contracts';
import {
  allStepIds,
  defaultRetries,
  insertStep,
  listSourcesAt,
  MAX_RETRIES,
  MAX_URLS,
  moveStep,
  newInput,
  newStep,
  removeStep,
  STEP_TYPES,
  updateStep,
  valuesAt,
  type StepPath,
  type StepType,
  type ValueRef,
} from './editorModel';

export interface WorkflowDraft {
  name: string;
  description: string;
  definition: WorkflowDefinition;
}

const STEP_TYPE_KEY: Record<StepType, string> = {
  fetch_page: 'workspace.workflows.editor.type.fetchPage',
  web_search: 'workspace.workflows.editor.type.webSearch',
  summarize: 'workspace.workflows.editor.type.summarize',
  template: 'workspace.workflows.editor.type.template',
  for_each: 'workspace.workflows.editor.type.forEach',
  save_artifact: 'workspace.workflows.editor.type.saveArtifact',
  notify: 'workspace.workflows.editor.type.notify',
};

/// Readable names for step outputs and item fields in the "Insert value" menu.
const FIELD_KEY: Record<string, string> = {
  text: 'workspace.workflows.editor.field.text',
  pages: 'workspace.workflows.editor.field.pages',
  'pages.0.title': 'workspace.workflows.editor.field.firstPageTitle',
  'pages.0.links': 'workspace.workflows.editor.field.firstPageLinks',
  results: 'workspace.workflows.editor.field.results',
  items: 'workspace.workflows.editor.field.items',
  data: 'workspace.workflows.editor.field.data',
  artifactId: 'workspace.workflows.editor.field.artifactId',
  title: 'workspace.workflows.editor.field.title',
  url: 'workspace.workflows.editor.field.url',
  snippet: 'workspace.workflows.editor.field.snippet',
  links: 'workspace.workflows.editor.field.links',
  index: 'workspace.workflows.editor.field.index',
  item: 'workspace.workflows.editor.field.item',
  date: 'workspace.workflows.editor.field.date',
};

export function refLabel(ref: ValueRef, t: Translate): string {
  const field = (name: string) => (FIELD_KEY[name] ? t(FIELD_KEY[name]) : name);
  switch (ref.source.kind) {
    case 'input':
      return ref.source.label || ref.field;
    case 'run':
      return field('date');
    case 'item': {
      // `summary.text` inside an earlier loop's items: step, then field.
      const [first, ...rest] = ref.field.split('.');
      return rest.length > 0 ? `${first} · ${field(rest.join('.'))}` : field(first);
    }
    case 'step':
      return `${ref.source.stepId} · ${field(ref.field)}`;
  }
}

export function WorkflowEditor({
  draft,
  onChange,
}: {
  draft: WorkflowDraft;
  onChange: (next: WorkflowDraft) => void;
}) {
  const t = useT();
  const def = draft.definition;
  const setDefinition = (definition: WorkflowDefinition) => onChange({ ...draft, definition });
  const setSteps = (steps: WorkflowStep[]) => setDefinition({ ...def, steps });
  const inputs = def.inputs ?? [];
  const setInputs = (next: WorkflowInput[]) => setDefinition({ ...def, inputs: next });

  return (
    <div className="wf-editor">
      <label className="wf-field">
        <span>{t('workspace.workflows.edit.name')}</span>
        <input className="mem-input" value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
      </label>
      <label className="wf-field">
        <span>{t('workspace.workflows.edit.description')}</span>
        <input
          className="mem-input"
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </label>

      <section className="grp" aria-label={t('workspace.workflows.editor.inputs.title')}>
        <div className="grp-label">{t('workspace.workflows.editor.inputs.title')}</div>
        <p className="wf-muted">{t('workspace.workflows.editor.inputs.hint')}</p>
        {inputs.map((input, index) => (
          <div key={input.id} className="wf-input-row">
            <input
              className="mem-input"
              aria-label={t('workspace.workflows.editor.inputs.label', { n: index + 1 })}
              placeholder={t('workspace.workflows.editor.inputs.labelPlaceholder')}
              value={input.label}
              onChange={(e) => setInputs(inputs.map((i) => (i.id === input.id ? { ...i, label: e.target.value } : i)))}
            />
            <input
              className="mem-input"
              aria-label={t('workspace.workflows.editor.inputs.default', { n: index + 1 })}
              placeholder={t('workspace.workflows.editor.inputs.defaultPlaceholder')}
              value={input.default ?? ''}
              onChange={(e) => setInputs(inputs.map((i) => (i.id === input.id ? { ...i, default: e.target.value } : i)))}
            />
            <button
              type="button"
              className="btn ghost"
              aria-label={t('workspace.workflows.editor.inputs.remove', { n: index + 1 })}
              onClick={() => setInputs(inputs.filter((i) => i.id !== input.id))}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn ghost wf-add"
          onClick={() => setInputs([...inputs, newInput(inputs, t('workspace.workflows.editor.inputs.newLabel'))])}
        >
          {t('workspace.workflows.editor.inputs.add')}
        </button>
      </section>

      <section className="grp" aria-label={t('workspace.workflows.steps.title')}>
        <div className="grp-label">{t('workspace.workflows.steps.title')}</div>
        <StepListEditor def={def} steps={def.steps} parent={[]} setSteps={setSteps} />
      </section>
    </div>
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
        {STEP_TYPES.map((type) => (
          <option key={type} value={type}>
            {t(STEP_TYPE_KEY[type])}
          </option>
        ))}
      </select>
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
}: {
  def: WorkflowDefinition;
  step: WorkflowStep;
  path: StepPath;
  position: number;
  count: number;
  setSteps: (steps: WorkflowStep[]) => void;
}) {
  const t = useT();
  const headingId = useId();
  const update = (fn: (s: WorkflowStep) => WorkflowStep) => setSteps(updateStep(def.steps, path, fn));
  const refs = valuesAt(def, path);
  const typeName = t(STEP_TYPE_KEY[step.type]);

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
          <div className="wf-nested">
            <StepListEditor def={def} steps={step.steps} parent={path} setSteps={setSteps} />
          </div>
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
        </>
      );
      break;
  }
  const usualRetries = defaultRetries(step.type);

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
      <div className="wf-card-body">{body}</div>
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
    </li>
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
        className="sel wf-insert"
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
