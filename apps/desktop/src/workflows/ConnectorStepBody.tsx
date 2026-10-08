/// The body of a "Use a connector" step card: pick an installed connector,
/// pick one of its tools (only tools that just read can be chosen), then fill
/// the tool's arguments from a form built from its input schema, or as one
/// JSON object.
///
/// Text arguments are template fields (chips, "Insert value"), so a tool can
/// be handed `{{inputs.repo}}` or an earlier step's output.

import { useEffect, useId, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import type { WorkflowStep } from '../ipc/contracts';
import {
  argFields,
  argsFromJson,
  argsToJson,
  isUsable,
  loadConnectorChoices,
  loadConnectorTools,
  missingRequired,
  parseNumber,
  withArg,
  type ArgField,
  type ConnectorChoice,
  type ConnectorToolInfo,
  type JsonObject,
} from './connectorTools';

type ConnectorStep = Extract<WorkflowStep, { type: 'connector_tool' }>;

type Loaded<T> = { state: 'loading' } | { state: 'error' } | { state: 'ready'; value: T };

/// A text field with the "Insert value" menu, supplied by the editor.
export type RenderTextField = (props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) => ReactNode;

export function ConnectorStepBody({
  step,
  update,
  renderText,
}: {
  step: ConnectorStep;
  update: (fn: (s: WorkflowStep) => WorkflowStep) => void;
  renderText: RenderTextField;
}) {
  const t = useT();
  const [choices, setChoices] = useState<Loaded<ConnectorChoice[]>>({ state: 'loading' });
  const [tools, setTools] = useState<Loaded<ConnectorToolInfo[]>>({ state: 'loading' });
  const [asJson, setAsJson] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => loadConnectorChoices())
      .then((value) => {
        if (!cancelled) setChoices({ state: 'ready', value });
      })
      .catch(() => {
        if (!cancelled) setChoices({ state: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const choice = choices.state === 'ready' ? choices.value.find((c) => c.connectorId === step.connector) : undefined;
  const connectorId = choice?.connectorId;

  useEffect(() => {
    if (!connectorId) return;
    let cancelled = false;
    setTools({ state: 'loading' });
    Promise.resolve()
      .then(() => loadConnectorTools(connectorId))
      .then((value) => {
        if (!cancelled) setTools({ state: 'ready', value });
      })
      .catch(() => {
        if (!cancelled) setTools({ state: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [connectorId]);

  const set = (patch: Partial<Pick<ConnectorStep, 'connector' | 'tool' | 'arguments'>>) =>
    update((s) => (s.type === 'connector_tool' ? { ...s, ...patch } : s));

  const toolList = tools.state === 'ready' && choice ? tools.value : null;
  const tool = toolList?.find((x) => x.name === step.tool);
  const args = step.arguments ?? {};
  const fields = tool ? argFields(tool.inputSchema) : null;
  const missing = missingRequired(fields, args);

  return (
    <>
      <label className="wf-field">
        <span>{t('workspace.workflows.editor.connector.connector')}</span>
        <select
          className="sel"
          value={step.connector}
          disabled={choices.state !== 'ready'}
          onChange={(e) => set({ connector: e.target.value, tool: '', arguments: {} })}
        >
          <option value="">{t('workspace.workflows.editor.connector.connectorPlaceholder')}</option>
          {choices.state === 'ready'
            ? choices.value.map((c) => (
                <option key={c.connectorId} value={c.connectorId}>
                  {t('workspace.workflows.editor.connector.connectorOption', { name: c.name, status: t(c.statusKey) })}
                </option>
              ))
            : null}
          {choices.state === 'ready' && step.connector && !choice ? (
            <option value={step.connector}>{t('workspace.workflows.editor.connector.connectorGone')}</option>
          ) : null}
        </select>
      </label>
      {choices.state === 'loading' ? <p className="wf-muted">{t('workspace.workflows.editor.connector.loading')}</p> : null}
      {choices.state === 'error' ? <p className="wf-error">{t('workspace.workflows.editor.connector.loadFailed')}</p> : null}
      {choices.state === 'ready' && choices.value.length === 0 ? (
        <p className="wf-muted">{t('workspace.workflows.editor.connector.none')}</p>
      ) : null}

      {choice ? (
        <>
          <label className="wf-field">
            <span>{t('workspace.workflows.editor.connector.tool')}</span>
            <select
              className="sel"
              value={step.tool}
              disabled={tools.state !== 'ready'}
              onChange={(e) => set({ tool: e.target.value, arguments: {} })}
            >
              <option value="">{t('workspace.workflows.editor.connector.toolPlaceholder')}</option>
              {(toolList ?? []).map((x) => (
                <option key={x.name} value={x.name} disabled={!isUsable(x)}>
                  {x.readOnly === true
                    ? x.name
                    : t(
                        x.readOnly === false
                          ? 'workspace.workflows.editor.connector.toolChanges'
                          : 'workspace.workflows.editor.connector.toolUnknown',
                        { tool: x.name },
                      )}
                </option>
              ))}
              {toolList && step.tool && !tool ? (
                <option value={step.tool}>{t('workspace.workflows.editor.connector.toolGone', { tool: step.tool })}</option>
              ) : null}
            </select>
          </label>
          {tools.state === 'loading' ? <p className="wf-muted">{t('workspace.workflows.editor.connector.loadingTools')}</p> : null}
          {tools.state === 'error' ? <p className="wf-error">{t('workspace.workflows.editor.connector.toolsFailed')}</p> : null}
          {toolList && toolList.length === 0 ? (
            <p className="wf-muted">{t('workspace.workflows.editor.connector.noTools', { name: choice.name })}</p>
          ) : null}
          {tool && !isUsable(tool) ? (
            <p className="wf-error">
              {t(
                tool.readOnly === false
                  ? 'workspace.workflows.editor.connector.notReadOnly'
                  : 'workspace.workflows.editor.connector.unknownReadOnly',
                { tool: tool.name, name: choice.name },
              )}
            </p>
          ) : null}
          {tool?.description ? <p className="wf-muted">{tool.description}</p> : null}
        </>
      ) : null}

      {step.tool ? (
        <fieldset className="wf-tools">
          <legend>{t('workspace.workflows.editor.connector.arguments')}</legend>
          {fields && !asJson ? (
            fields.map((field) => (
              <ArgumentField
                key={field.key}
                field={field}
                value={args[field.key]}
                onChange={(v) => set({ arguments: withArg(args, field.key, v) })}
                renderText={renderText}
              />
            ))
          ) : (
            <JsonArguments key={step.tool} args={args} onChange={(next) => set({ arguments: next })} />
          )}
          {fields && !asJson && missing.length > 0 ? (
            <p className="wf-muted">{t('workspace.workflows.editor.connector.missing', { fields: missing.join(', ') })}</p>
          ) : null}
          {fields ? (
            <button type="button" className="btn ghost wf-add" onClick={() => setAsJson((v) => !v)}>
              {asJson
                ? t('workspace.workflows.editor.connector.showForm')
                : t('workspace.workflows.editor.connector.showJson')}
            </button>
          ) : null}
        </fieldset>
      ) : null}
    </>
  );
}

/// One argument: a template field for text, a number box, a menu for an enum or
/// a yes/no, or a small JSON box for anything else.
function ArgumentField({
  field,
  value,
  onChange,
  renderText,
}: {
  field: ArgField;
  value: unknown;
  onChange: (value: unknown) => void;
  renderText: RenderTextField;
}) {
  const t = useT();
  const label = field.required
    ? t('workspace.workflows.editor.connector.requiredLabel', { label: field.label })
    : field.label;
  switch (field.kind) {
    case 'string':
      return (
        <>
          {renderText({
            label,
            value: typeof value === 'string' ? value : '',
            onChange: (v) => onChange(v),
          })}
          {field.description ? <p className="wf-muted">{field.description}</p> : null}
        </>
      );
    case 'number':
    case 'integer':
      return (
        <label className="wf-field wf-narrow">
          <span>{label}</span>
          <input
            className="mem-input"
            type="number"
            step={field.kind === 'integer' ? 1 : 'any'}
            value={typeof value === 'number' ? value : ''}
            onChange={(e) => onChange(parseNumber(e.target.value, field.kind === 'integer'))}
          />
        </label>
      );
    case 'boolean':
      return (
        <label className="wf-field wf-narrow">
          <span>{label}</span>
          <select
            className="sel"
            value={typeof value === 'boolean' ? String(value) : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}
          >
            <option value="">{t('workspace.workflows.editor.connector.notSet')}</option>
            <option value="true">{t('workspace.workflows.editor.connector.yes')}</option>
            <option value="false">{t('workspace.workflows.editor.connector.no')}</option>
          </select>
        </label>
      );
    case 'enum':
      return (
        <label className="wf-field">
          <span>{label}</span>
          <select
            className="sel"
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
          >
            <option value="">{t('workspace.workflows.editor.connector.notSet')}</option>
            {(field.options ?? []).map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
      );
    case 'json':
      return <JsonValue label={label} value={value} onChange={onChange} />;
  }
}

/// A JSON box for one argument of a shape the form can't draw.
function JsonValue({ label, value, onChange }: { label: string; value: unknown; onChange: (value: unknown) => void }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value));
  const [bad, setBad] = useState(false);
  return (
    <label className="wf-field" htmlFor={id}>
      <span>{label}</span>
      <textarea
        id={id}
        className="mem-input"
        rows={2}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === '') {
            setBad(false);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad ? <span className="wf-error">{t('workspace.workflows.editor.connector.jsonInvalid')}</span> : null}
    </label>
  );
}

/// The whole arguments object as JSON, for tools without a form (or when asked).
function JsonArguments({ args, onChange }: { args: JsonObject; onChange: (args: JsonObject) => void }) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState(() => argsToJson(args));
  const [bad, setBad] = useState(false);
  return (
    <label className="wf-field" htmlFor={id}>
      <span>{t('workspace.workflows.editor.connector.argumentsJson')}</span>
      <textarea
        id={id}
        className="mem-input"
        rows={6}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = argsFromJson(e.target.value);
          setBad(parsed === null);
          if (parsed) onChange(parsed);
        }}
      />
      {bad ? <span className="wf-error">{t('workspace.workflows.editor.connector.argumentsJsonInvalid')}</span> : null}
    </label>
  );
}
