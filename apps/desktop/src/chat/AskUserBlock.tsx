import { useState } from 'react';
import { submitAskUser } from '../ipc/client';
import { useT } from '../i18n';
import { ScheduleTaskCard } from './ScheduleTaskCard';

export interface AskUserFieldView {
  id: string;
  prompt: string;
  type: string;
  options?: string[] | null;
}

interface AskUserBlockProps {
  toolCallId: string;
  title: string;
  fields: AskUserFieldView[];
  onDone?: () => void;
}

/** The field type that carries a `schedule_task` draft (its prompt is the call's arguments as JSON). */
export const SCHEDULE_TASK_FIELD_TYPE = 'schedule_task';

/** What a paused turn waits on: an ask_user form, or the confirm card of a drafted scheduled task. */
export function AskUserBlock(props: AskUserBlockProps) {
  const draft = props.fields.find((f) => f.type === SCHEDULE_TASK_FIELD_TYPE);
  if (draft) {
    return <ScheduleTaskCard toolCallId={props.toolCallId} argumentsJson={draft.prompt} onDone={props.onDone} />;
  }
  return <AskUserForm {...props} />;
}

/** Mid-turn ask_user form (t1-2). Answers are user-authored content. */
function AskUserForm({ toolCallId, title, fields, onDone }: AskUserBlockProps) {
  const t = useT();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) init[f.id] = '';
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await submitAskUser(toolCallId, values);
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function dismiss() {
    setBusy(true);
    try {
      await submitAskUser(toolCallId, { cancelled: true });
      onDone?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ask-user" role="form" aria-label={title}>
      <p className="ask-user-title">
        <b>{title}</b>
      </p>
      {fields.map((field) => (
        <label key={field.id} className="ask-user-field">
          <span>{field.prompt}</span>
          {field.type === 'choice' && field.options && field.options.length > 0 ? (
            <select
              value={values[field.id] ?? ''}
              disabled={busy}
              onChange={({ target: { value } }) => setValues((v) => ({ ...v, [field.id]: value }))}
            >
              <option value="">{t('chat.askUser.choosePlaceholder')}</option>
              {field.options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={values[field.id] ?? ''}
              disabled={busy}
              onChange={({ target: { value } }) => setValues((v) => ({ ...v, [field.id]: value }))}
            />
          )}
        </label>
      ))}
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void submit()}>
          {t('chat.askUser.submitButton')}
        </button>
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void dismiss()}>
          {t('common.actions.dismiss')}
        </button>
      </div>
    </div>
  );
}
