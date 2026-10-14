/// A run waiting to send something out: a connector tool that changes things
/// (send, post, create). The card shows the exact call so the user can send it,
/// change it, or stop it. Shared by the Workflows page and the Inbox.

import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { answerWorkflowAction } from '../ipc/client';
import type { WorkflowAction } from '../ipc/contracts';
import { formatNextRun } from './ScheduleSection';

type FieldKind = 'text' | 'number' | 'boolean' | 'json';

interface Field {
  name: string;
  kind: FieldKind;
  /// What the input holds: text, a number as typed, `true`/`false`, or JSON.
  value: string | boolean;
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/// An argument as a person reads it: text as written, anything else as JSON.
function display(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
}

function schemaProperties(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const props = schema.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {};
  return props as Record<string, Record<string, unknown>>;
}

/// The Edit form's fields: the schema's top-level properties, then any argument it doesn't describe.
function buildFields(action: WorkflowAction): Field[] {
  const props = schemaProperties(action.inputSchema);
  const names = [...Object.keys(props), ...Object.keys(action.arguments).filter((k) => !(k in props))];
  return names.map((name) => {
    const value = action.arguments[name];
    const type = props[name]?.type;
    if (type === 'string' && (value === undefined || typeof value === 'string')) {
      return { name, kind: 'text', value: (value as string | undefined) ?? '' };
    }
    if ((type === 'number' || type === 'integer') && (value === undefined || typeof value === 'number')) {
      return { name, kind: 'number', value: value === undefined ? '' : String(value) };
    }
    if (type === 'boolean' && (value === undefined || typeof value === 'boolean')) {
      return { name, kind: 'boolean', value: value === true };
    }
    return { name, kind: 'json', value: value === undefined ? '' : (JSON.stringify(value, null, 2) ?? '') };
  });
}

export function ActionCard({
  action,
  onAnswered,
}: {
  action: WorkflowAction;
  /// The backend took the answer (`taken`), or the run was no longer waiting.
  onAnswered: (action: WorkflowAction, taken: boolean) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const [remember, setRemember] = useState(false);
  const [fields, setFields] = useState<Field[]>([]);
  const [wholeJson, setWholeJson] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const hasSchema = Object.keys(schemaProperties(action.inputSchema)).length > 0;
  const entries = Object.entries(action.arguments);

  function startEditing() {
    setFields(buildFields(action));
    setWholeJson(JSON.stringify(action.arguments, null, 2));
    setFieldErrors({});
    setEditing(true);
  }

  function setField(name: string, value: string | boolean) {
    setFields((current) => current.map((f) => (f.name === name ? { ...f, value } : f)));
    setFieldErrors((current) => {
      const { [name]: _cleared, ...rest } = current;
      return rest;
    });
  }

  /// The edited arguments, or `null` after showing what is wrong.
  function editedArguments(): Record<string, unknown> | null {
    if (!hasSchema) {
      try {
        const parsed: unknown = JSON.parse(wholeJson);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setFieldErrors({ '': t('workspace.workflows.action.notObject') });
          return null;
        }
        return parsed as Record<string, unknown>;
      } catch {
        setFieldErrors({ '': t('workspace.workflows.action.invalidJson') });
        return null;
      }
    }
    const next: Record<string, unknown> = {};
    const errors: Record<string, string> = {};
    for (const field of fields) {
      if (field.kind === 'boolean') {
        next[field.name] = field.value === true;
      } else if (field.kind === 'text') {
        // An untouched empty box leaves the argument out, as it was.
        if (field.value !== '' || field.name in action.arguments) next[field.name] = field.value;
      } else if (field.kind === 'number') {
        const text = String(field.value).trim();
        if (text === '') continue;
        const n = Number(text);
        if (Number.isFinite(n)) next[field.name] = n;
        else errors[field.name] = t('workspace.workflows.action.invalidNumber');
      } else {
        const text = String(field.value).trim();
        if (text === '') continue;
        try {
          next[field.name] = JSON.parse(text) as unknown;
        } catch {
          errors[field.name] = t('workspace.workflows.action.invalidJson');
        }
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length > 0 ? null : next;
  }

  async function answer(send: boolean, args?: Record<string, unknown>) {
    setSending(true);
    setRefused(null);
    try {
      const taken = await answerWorkflowAction(action.runId, action.stepId, {
        send,
        ...(args ? { arguments: args } : {}),
        ...(send && remember && !action.sensitive ? { remember: true } : {}),
      });
      onAnswered(action, taken);
    } catch (e) {
      if (alive.current) setRefused(t('workspace.workflows.action.failed', { error: errorText(e) }));
    } finally {
      if (alive.current) setSending(false);
    }
  }

  function sendEdited() {
    const args = editedArguments();
    if (args) void answer(true, args);
  }

  return (
    <section
      className="wf-offer wf-review wf-action"
      role="group"
      aria-labelledby={headingId}
      data-run-id={action.runId}
    >
      <b id={headingId}>{t('workspace.workflows.action.title')}</b>
      <p className="wf-review-what">
        {t('workspace.workflows.action.what', { tool: action.tool, connector: action.connectorName })}
      </p>
      {action.description ? <p className="wf-muted">{action.description}</p> : null}
      {editing ? (
        <div className="wf-action-form">
          {hasSchema ? (
            fields.map((field) => (
              <ActionField
                key={field.name}
                field={field}
                error={fieldErrors[field.name]}
                disabled={sending}
                onChange={(value) => setField(field.name, value)}
              />
            ))
          ) : (
            <label className="wf-field">
              <span>{t('workspace.workflows.action.allArguments')}</span>
              <textarea
                className="mem-input wf-action-json"
                rows={6}
                spellCheck={false}
                value={wholeJson}
                disabled={sending}
                aria-invalid={fieldErrors[''] ? true : undefined}
                onChange={(e) => {
                  setWholeJson(e.target.value);
                  setFieldErrors({});
                }}
              />
              {fieldErrors[''] ? (
                <span className="wf-error" role="alert">
                  {fieldErrors['']}
                </span>
              ) : null}
            </label>
          )}
        </div>
      ) : entries.length > 0 ? (
        <dl className="wf-action-args" aria-label={t('workspace.workflows.action.argsLabel')}>
          {entries.map(([name, value]) => (
            <div key={name} className="wf-action-arg">
              <dt>{name}</dt>
              <dd>
                <pre>{display(value)}</pre>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="wf-muted">{t('workspace.workflows.action.noArgs')}</p>
      )}
      <p className="wf-muted">
        {t('workspace.workflows.review.expires', { when: formatNextRun(action.expiresAt, fmt.locale) })}
      </p>
      {action.sensitive ? (
        <p className="wf-muted">{t('workspace.workflows.action.alwaysAsks')}</p>
      ) : (
        <label className="wf-action-remember">
          <input
            type="checkbox"
            checked={remember}
            disabled={sending}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>{t('workspace.workflows.action.remember')}</span>
        </label>
      )}
      <div className="wf-offer-actions">
        {editing ? (
          <>
            <button type="button" className="btn primary" disabled={sending} onClick={sendEdited}>
              {t('workspace.workflows.action.send')}
            </button>
            <button type="button" className="btn" disabled={sending} onClick={() => setEditing(false)}>
              {t('workspace.workflows.action.cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary" disabled={sending} onClick={() => void answer(true)}>
              {t('workspace.workflows.action.send')}
            </button>
            <button type="button" className="btn" disabled={sending} onClick={startEditing}>
              {t('workspace.workflows.action.edit')}
            </button>
            <button type="button" className="btn ghost" disabled={sending} onClick={() => void answer(false)}>
              {t('workspace.workflows.action.dontSend')}
            </button>
          </>
        )}
      </div>
      {refused ? (
        <p className="wf-error" role="alert">
          {refused}
        </p>
      ) : null}
    </section>
  );
}

function ActionField({
  field,
  error,
  disabled,
  onChange,
}: {
  field: Field;
  error: string | undefined;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}) {
  if (field.kind === 'boolean') {
    return (
      <label className="wf-action-remember">
        <input
          type="checkbox"
          checked={field.value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{field.name}</span>
      </label>
    );
  }
  const text = String(field.value);
  return (
    <label className="wf-field">
      <span>{field.name}</span>
      {field.kind === 'number' ? (
        <input
          className="mem-input"
          type="number"
          step="any"
          value={text}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <textarea
          className={`mem-input${field.kind === 'json' ? ' wf-action-json' : ''}`}
          rows={field.kind === 'json' ? 4 : 3}
          spellCheck={field.kind !== 'json'}
          value={text}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error ? (
        <span className="wf-error" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}
