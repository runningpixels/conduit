import { useState } from 'react';
import { submitAskUser } from '../ipc/client';

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

/** Mid-turn ask_user form (t1-2). Answers are user-authored content. */
export function AskUserBlock({ toolCallId, title, fields, onDone }: AskUserBlockProps) {
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
              onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
            >
              <option value="">Choose…</option>
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
              onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
            />
          )}
        </label>
      ))}
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button className="btn primary" type="button" disabled={busy} onClick={() => void submit()}>
          Submit
        </button>
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
