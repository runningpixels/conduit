/// The bar above the workflow editor: back, the name, what still needs fixing,
/// the JSON toggle, Cancel and Save.

import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n';

export function WorkflowEditBar({
  name,
  onName,
  problems,
  json,
  onToggleJson,
  onCancel,
  onSave,
  busy,
}: {
  name: string;
  onName: (name: string) => void;
  problems: readonly string[];
  /** The JSON view is open. */
  json: boolean;
  onToggleJson: () => void;
  /** Back and Cancel both leave without saving. */
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const t = useT();
  const popoverId = useId();
  const [open, setOpen] = useState(false);
  const hasProblems = problems.length > 0;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="wfv-editbar">
      <button type="button" className="btn ghost wfv-back-btn" aria-label={t('workspace.workflows.view.back')} onClick={onCancel}>
        <span aria-hidden="true">←</span>
      </button>
      <label className="wfv-name-field">
        <span className="wfv-editing">{t('workspace.workflows.edit.editing')}</span>
        <input
          className="wfv-name-input"
          value={name}
          aria-label={t('workspace.workflows.edit.name')}
          onChange={(e) => onName(e.target.value)}
        />
      </label>
      <div className="wfv-editbar-actions">
        {hasProblems ? (
          <div className="wfv-problems-wrap">
            <button
              type="button"
              className="wfv-problems-pill"
              aria-expanded={open && hasProblems}
              aria-controls={popoverId}
              onClick={() => setOpen((v) => !v)}
            >
              {t('workspace.workflows.edit.problemsCount', { count: problems.length })}
            </button>
            {open ? (
              <div id={popoverId} className="wfv-problems-pop" role="status">
                <p className="wfv-problems-title">{t('workspace.workflows.editor.problems')}</p>
                <ul>
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
        <button type="button" className="btn ghost" onClick={onToggleJson}>
          {json ? t('workspace.workflows.editor.showVisual') : t('workspace.workflows.editor.showJson')}
        </button>
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t('common.actions.cancel')}
        </button>
        <button type="button" className="btn primary" onClick={onSave} disabled={busy || hasProblems || !name.trim()}>
          {t('workspace.workflows.edit.save')}
        </button>
      </div>
    </div>
  );
}
