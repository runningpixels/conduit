/// The launch-inputs form for a saved app (ADR-013): a form generated from
/// `app.inputs`, one control per declared input. Save calls `setAppInputs`
/// (Rust re-validates and rejects with `invalid: …`), and the caller is
/// responsible for pushing the returned values to the running page — this
/// dialog only reports the new values back via `onSaved`, it never touches
/// the frame itself.
///
/// Rendered at the app shell, over the app's own frame: Escape is caught in
/// the capture phase, same as `AppDetailsDialog`, so the document panel's own
/// Escape handling (if this ever opens over one) never sees it first.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { useT } from '../i18n';
import type { AppInput } from '../artifacts/networkHosts';
import { setAppInputs } from '../ipc/client';

export interface AppInputsDialogProps {
  /** The app to edit inputs for; `null` closes the dialog. */
  appId: string | null;
  /** The app's declared inputs, in declaration order. */
  inputs: AppInput[];
  /** The current effective values (from `getAppInputs`), keyed by input id. */
  values: Record<string, unknown>;
  onClose: () => void;
  /** The new effective values, as `setAppInputs` returned them. */
  onSaved: (values: Record<string, unknown>) => void;
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function AppInputControl({
  input,
  value,
  onChange,
}: {
  input: AppInput;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  switch (input.type) {
    case 'string':
      return (
        <input
          type="text"
          maxLength={500}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'number':
      return (
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      );
    case 'boolean':
      return <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
    case 'enum':
      return (
        <select value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled hidden />
          {(input.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    case 'date':
      return (
        <input type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />
      );
    default:
      return null;
  }
}

export function AppInputsDialog({ appId, inputs, values, onClose, onSaved }: AppInputsDialogProps) {
  const t = useT();
  const titleId = useId();
  const dialogRef = useRef<HTMLFormElement>(null);
  const open = appId != null;
  useFocusTrap(dialogRef, open);

  const [draft, setDraft] = useState<Record<string, unknown>>(values);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(values);
    setFieldErrors({});
    setError(null);
    setBusy(false);
    // Only reset when the dialog (re)opens for an app — not on every render
    // that happens to carry a new `values` object identity while it's open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, appId]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onClose]);

  if (!open || !appId) return null;

  function setValue(id: string, value: unknown) {
    setDraft((current) => ({ ...current, [id]: value }));
    setFieldErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !appId) return;
    const nextErrors: Record<string, string> = {};
    for (const input of inputs) {
      if (input.required && isEmptyValue(draft[input.id])) {
        nextErrors[input.id] = t('apps.inputs.requiredError');
      }
    }
    if (Object.keys(nextErrors).length > 0) {
      setFieldErrors(nextErrors);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = await setAppInputs(appId, draft);
      onSaved(saved);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div
      className="consent-overlay app-inputs-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        ref={dialogRef}
        className="app-inputs-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => void submit(e)}
      >
        <h2 id={titleId}>{t('apps.inputs.title')}</h2>

        {inputs.map((input) => (
          <label key={input.id} className="app-field">
            <span className="app-field-label">
              {input.label}
              {input.required && (
                <span className="app-field-required">{' '}{t('apps.inputs.requiredMark')}</span>
              )}
            </span>
            <AppInputControl input={input} value={draft[input.id]} onChange={(value) => setValue(input.id, value)} />
            {fieldErrors[input.id] && (
              <span className="app-inputs-field-error" role="alert">
                {fieldErrors[input.id]}
              </span>
            )}
          </label>
        ))}

        {error && (
          <p className="app-inputs-error" role="alert">
            {error}
          </p>
        )}

        <div className="app-details-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {t('apps.inputs.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
