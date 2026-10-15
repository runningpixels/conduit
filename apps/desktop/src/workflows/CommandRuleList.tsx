/// A list of command rules with a box to add one. While the user types, the
/// backend says what the rule would match ("git log *" covers "git log --oneline"),
/// or why it can't be used. Used for a workflow's allow and deny rules and for
/// the global deny rules in Settings.
///
/// A rule is a program plus leading arguments, optionally ending in " *".

import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n';
import { previewCommandRule } from '../ipc/client';
import type { CommandRulePreview } from '../ipc/contracts';

/// What a refused save said: the backend's plain error (an `IpcError` is not an `Error`, but has a message).
export function rejectionText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

export function CommandRuleList({
  label,
  hint,
  rules,
  busy,
  error,
  onAdd,
  onRemove,
}: {
  label: string;
  hint?: string;
  rules: readonly string[];
  busy: boolean;
  /// Shown under the list: what the backend said when a save was refused.
  error: string | null;
  /// Resolves `true` when the rule was saved; the box is cleared only then, so a refused rule stays to be fixed.
  onAdd: (rule: string) => Promise<boolean>;
  onRemove: (rule: string) => void;
}) {
  const t = useT();
  const inputId = useId();
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<CommandRulePreview | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const rule = draft.trim();

  useEffect(() => {
    setPreview(null);
    setPreviewFailed(false);
    if (!rule) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => previewCommandRule(rule))
      .then(
        (p) => {
          if (!cancelled) setPreview(p);
        },
        () => {
          if (!cancelled) setPreviewFailed(true);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [rule]);

  const duplicate = rules.includes(rule);
  const add = () => {
    if (!rule || duplicate || preview?.error) return;
    void onAdd(rule).then((saved) => {
      if (saved) setDraft((current) => (current.trim() === rule ? '' : current));
    });
  };

  return (
    <div className="wf-cmdrules" role="group" aria-label={label}>
      <p className="wf-io-label">{label}</p>
      {hint ? <p className="wf-muted">{hint}</p> : null}
      {rules.length === 0 ? (
        <p className="wf-muted">{t('workspace.workflows.commands.none')}</p>
      ) : (
        <ul className="wf-actions-allowed">
          {rules.map((r) => (
            <li key={r}>
              <code>{r}</code>
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                aria-label={t('workspace.workflows.commands.removeLabel', { rule: r })}
                onClick={() => onRemove(r)}
              >
                {t('workspace.workflows.outside.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="wf-cmdrules-add">
        <input
          id={inputId}
          className="mem-input"
          spellCheck={false}
          aria-label={t('workspace.workflows.commands.newLabel', { list: label })}
          placeholder={t('workspace.workflows.commands.placeholder')}
          value={draft}
          disabled={busy}
          aria-invalid={preview?.error ? true : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={busy || !rule || duplicate || Boolean(preview?.error)}
          aria-label={t('workspace.workflows.commands.addLabel', { list: label })}
          onClick={add}
        >
          {t('workspace.workflows.commands.add')}
        </button>
      </div>
      {preview?.error ? (
        <p className="wf-error" role="alert">
          {preview.error}
        </p>
      ) : preview ? (
        <div className="wf-cmdrules-preview" aria-live="polite">
          {preview.covers.length > 0 ? (
            <p className="wf-muted">
              {t('workspace.workflows.commands.covers')} <code>{preview.covers.join('  ·  ')}</code>
            </p>
          ) : null}
          {preview.doesNotCover.length > 0 ? (
            <p className="wf-muted">
              {t('workspace.workflows.commands.doesNotCover')} <code>{preview.doesNotCover.join('  ·  ')}</code>
            </p>
          ) : null}
        </div>
      ) : previewFailed ? (
        <p className="wf-muted">{t('workspace.workflows.commands.previewFailed')}</p>
      ) : null}
      {error ? (
        <p className="wf-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
