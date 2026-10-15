/// "Starts when": what begins a run on its own besides the user. A workflow
/// either runs when asked (or on a time schedule, set on its page) or watches
/// something: a feed for new posts, its own folder for new files, or a
/// connector for new things its tool lists. Turning the watch on happens with
/// "Run automatically" on the workflow's page.
/// Four radio cards; the chosen one shows its own fields under it.

import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n';
import type { WorkflowDefinition, WorkflowTrigger } from '../ipc/contracts';
import { ArgumentField, JsonArguments, reasonOf } from './ConnectorStepBody';
import {
  argFields,
  loadConnectorChoices,
  loadConnectorTools,
  missingRequired,
  withArg,
  type ConnectorChoice,
  type ConnectorToolInfo,
} from './connectorTools';
import { clampFeedMinutes, FEED_MINUTE_CHOICES, newTrigger, triggerNeedsFolder, withTrigger } from './editorModel';

type Choice = 'none' | WorkflowTrigger['kind'];

export function TriggerSection({
  def,
  onChange,
}: {
  def: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const t = useT();
  const urlId = useId();
  const groupName = useId();
  const trigger = def.trigger;
  const choice: Choice = trigger?.kind ?? 'none';

  const pick = (next: Choice) => {
    if (next !== choice) onChange(withTrigger(def, next === 'none' ? null : newTrigger(next)));
  };
  const card = (value: Choice, title: string) => (
    <label className={`wfe-radio${choice === value ? ' is-selected' : ''}`}>
      <input type="radio" name={groupName} checked={choice === value} onChange={() => pick(value)} />
      <span>{title}</span>
    </label>
  );

  return (
    <fieldset className="wfe-fieldset">
      <legend className="wfe-h">{t('workspace.workflows.trigger.when')}</legend>
      <div className="wfe-radio-group">
        {card('none', t('workspace.workflows.trigger.none'))}
        {choice === 'none' ? <p className="wfe-help wfe-radio-extra">{t('workspace.workflows.editor.start.scheduleNote')}</p> : null}
        {card('feed', t('workspace.workflows.trigger.feed'))}
        {trigger?.kind === 'feed' ? (
          <div className="wfe-radio-extra">
            <label className="wfe-field" htmlFor={urlId}>
              <span>{t('workspace.workflows.trigger.feedUrl')}</span>
              <input
                id={urlId}
                className="mem-input"
                type="url"
                value={trigger.url}
                onChange={(e) => onChange(withTrigger(def, { ...trigger, url: e.target.value }))}
              />
            </label>
            <label className="wfe-field">
              <span>{t('workspace.workflows.trigger.every')}</span>
              <MinutesSelect
                minutes={trigger.everyMinutes}
                onChange={(m) => onChange(withTrigger(def, { ...trigger, everyMinutes: m }))}
              />
            </label>
            <p className="wfe-help">{t('workspace.workflows.trigger.feedHint')}</p>
          </div>
        ) : null}
        {card('folder', t('workspace.workflows.trigger.folder'))}
        {trigger?.kind === 'folder' ? (
          <div className="wfe-radio-extra">
            <p className="wfe-help">{t('workspace.workflows.trigger.folderHint')}</p>
            {triggerNeedsFolder(def) ? <p className="wfe-error">{t('workspace.workflows.trigger.needsFolder')}</p> : null}
          </div>
        ) : null}
        {card('connector', t('workspace.workflows.trigger.connector'))}
        {trigger?.kind === 'connector' ? (
          <div className="wfe-radio-extra">
            <ConnectorTriggerFields trigger={trigger} onChange={(next) => onChange(withTrigger(def, next))} />
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}

/// The "Check every" menu: the usual choices, plus the current value when it is none of them.
function MinutesSelect({ minutes, onChange }: { minutes: number; onChange: (minutes: number) => void }) {
  const t = useT();
  const choices: number[] = FEED_MINUTE_CHOICES.includes(minutes as (typeof FEED_MINUTE_CHOICES)[number])
    ? [...FEED_MINUTE_CHOICES]
    : [...FEED_MINUTE_CHOICES, minutes].filter((m) => m > 0).sort((a, b) => a - b);
  return (
    <select className="sel" value={minutes} onChange={(e) => onChange(clampFeedMinutes(Number(e.target.value)))}>
      {choices.map((m) => (
        <option key={m} value={m}>
          {t('workspace.workflows.trigger.minutes', { count: m })}
        </option>
      ))}
    </select>
  );
}

type Loaded<T> = { state: 'loading' } | { state: 'error'; reason?: string } | { state: 'ready'; value: T };
type ConnectorTrigger = Extract<WorkflowTrigger, { kind: 'connector' }>;

/// The connector card's fields: which connector, which read-only tool lists
/// what is new, that tool's arguments (plain values, written as they are), and how often.
function ConnectorTriggerFields({
  trigger,
  onChange,
}: {
  trigger: ConnectorTrigger;
  onChange: (next: ConnectorTrigger) => void;
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

  const choice = choices.state === 'ready' ? choices.value.find((c) => c.connectorId === trigger.connector) : undefined;
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
      .catch((error: unknown) => {
        if (!cancelled) setTools({ state: 'error', reason: reasonOf(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [connectorId]);

  const set = (patch: Partial<Pick<ConnectorTrigger, 'connector' | 'tool' | 'arguments'>>) =>
    onChange({ ...trigger, ...patch });

  const readOnlyTools = tools.state === 'ready' && choice ? tools.value.filter((x) => x.readOnly === true) : null;
  const tool = readOnlyTools?.find((x) => x.name === trigger.tool);
  const args = trigger.arguments ?? {};
  const fields = tool ? argFields(tool.inputSchema) : null;
  const missing = missingRequired(fields, args);

  return (
    <>
      <label className="wf-field">
        <span>{t('workspace.workflows.editor.connector.connector')}</span>
        <select
          className="sel"
          value={trigger.connector}
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
          {choices.state === 'ready' && trigger.connector && !choice ? (
            <option value={trigger.connector}>{t('workspace.workflows.editor.connector.connectorGone')}</option>
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
            <span>{t('workspace.workflows.trigger.connectorTool')}</span>
            <select
              className="sel"
              value={trigger.tool}
              disabled={tools.state !== 'ready'}
              onChange={(e) => set({ tool: e.target.value, arguments: {} })}
            >
              <option value="">{t('workspace.workflows.editor.connector.toolPlaceholder')}</option>
              {(readOnlyTools ?? []).map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name}
                </option>
              ))}
              {readOnlyTools && trigger.tool && !tool ? (
                <option value={trigger.tool}>
                  {t('workspace.workflows.editor.connector.toolGone', { tool: trigger.tool })}
                </option>
              ) : null}
            </select>
          </label>
          {tools.state === 'loading' ? <p className="wf-muted">{t('workspace.workflows.editor.connector.loadingTools')}</p> : null}
          {tools.state === 'error' ? (
            <p className="wf-error" role="alert">
              {tools.reason ?? t('workspace.workflows.editor.connector.toolsFailed')}
            </p>
          ) : null}
          {tools.state === 'ready' && tools.value.length === 0 ? (
            <p className="wf-muted">{t('workspace.workflows.editor.connector.noTools', { name: choice.name })}</p>
          ) : null}
          {readOnlyTools && tools.state === 'ready' && tools.value.length > 0 && readOnlyTools.length === 0 ? (
            <p className="wf-muted">{t('workspace.workflows.trigger.connectorNoReadTools', { name: choice.name })}</p>
          ) : null}
          {tool?.description ? <p className="wf-muted">{tool.description}</p> : null}
        </>
      ) : null}

      {trigger.tool ? (
        <fieldset className="wf-tools">
          <legend>{t('workspace.workflows.editor.connector.arguments')}</legend>
          {fields && !asJson ? (
            fields.map((field) => (
              <ArgumentField
                key={field.key}
                field={field}
                value={args[field.key]}
                onChange={(v) => set({ arguments: withArg(args, field.key, v) })}
                renderText={(p) => (
                  <label className="wf-field">
                    <span>{p.label}</span>
                    <input
                      className="mem-input"
                      type="text"
                      value={p.value}
                      onChange={(e) => p.onChange(e.target.value)}
                    />
                  </label>
                )}
              />
            ))
          ) : (
            <JsonArguments key={trigger.tool} args={args} onChange={(next) => set({ arguments: next })} />
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

      <label className="wfe-field">
        <span>{t('workspace.workflows.trigger.every')}</span>
        <MinutesSelect minutes={trigger.everyMinutes} onChange={(m) => onChange({ ...trigger, everyMinutes: m })} />
      </label>
      <p className="wfe-help">{t('workspace.workflows.trigger.connectorHint')}</p>
    </>
  );
}
