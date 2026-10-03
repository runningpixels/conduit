import { useId, useRef, useState } from 'react';
import { useT } from '../../i18n';
import type { ResearchBrief, ResearchDepth } from '../../ipc/contracts';
import { DEPTH_ESTIMATE, DEPTH_LABEL_ID, DEPTH_ORDER, MAX_SUB_QUESTIONS } from './depthBudgets';

interface ResearchBriefEditorProps {
  brief: ResearchBrief;
  busy: boolean;
  error: string | null;
  onStart: (brief: ResearchBrief) => void;
  onCancel: () => void;
}

interface Row {
  key: number;
  text: string;
}

/**
 * The plan the user approves before anything is searched: the question as
 * asked (read-only), the sub-questions the run will chase (1 to 6, editable),
 * an optional scope and the depth. Domain preferences the planner chose are
 * carried through untouched.
 */
export function ResearchBriefEditor({ brief, busy, error, onStart, onCancel }: ResearchBriefEditorProps) {
  const t = useT();
  const uid = useId();
  const nextKey = useRef(brief.subQuestions.length);
  const [rows, setRows] = useState<Row[]>(() =>
    (brief.subQuestions.length > 0 ? brief.subQuestions : ['']).map((text, key) => ({ key, text })),
  );
  const [scope, setScope] = useState(brief.scope ?? '');
  const [depth, setDepth] = useState<ResearchDepth>(brief.depth);

  const filled = rows.map((row) => row.text.trim()).filter((text) => text !== '');
  const canStart = !busy && filled.length >= 1 && filled.length <= MAX_SUB_QUESTIONS;

  function addRow() {
    if (rows.length >= MAX_SUB_QUESTIONS) return;
    setRows((current) => [...current, { key: nextKey.current++, text: '' }]);
  }

  return (
    <form
      className="research-brief"
      aria-label={t('chat.research.brief.ariaLabel')}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canStart) return;
        onStart({
          ...brief,
          subQuestions: filled,
          scope: scope.trim() === '' ? null : scope.trim(),
          depth,
        });
      }}
    >
      <div className="research-field">
        <span className="research-label">{t('chat.research.brief.question')}</span>
        <p className="research-question">{brief.question}</p>
      </div>

      <fieldset className="research-field research-subs" disabled={busy}>
        <legend className="research-label">{t('chat.research.brief.subQuestions')}</legend>
        <ul className="research-sub-list">
          {rows.map((row, index) => (
            <li key={row.key} className="research-sub-row">
              <input
                type="text"
                value={row.text}
                aria-label={t('chat.research.brief.subQuestionN', { index: index + 1 })}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((r) => (r.key === row.key ? { ...r, text: event.target.value } : r)),
                  )
                }
              />
              <button
                type="button"
                className="btn ghost"
                disabled={rows.length <= 1}
                aria-label={t('chat.research.brief.removeSubQuestionN', { index: index + 1 })}
                onClick={() => setRows((current) => current.filter((r) => r.key !== row.key))}
              >
                {t('chat.research.brief.remove')}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn ghost" disabled={rows.length >= MAX_SUB_QUESTIONS} onClick={addRow}>
          {t('chat.research.brief.addSubQuestion')}
        </button>
      </fieldset>

      <label className="research-field">
        <span className="research-label">{t('chat.research.brief.scope')}</span>
        <input
          type="text"
          value={scope}
          disabled={busy}
          placeholder={t('chat.research.brief.scopePlaceholder')}
          onChange={(event) => setScope(event.target.value)}
        />
      </label>

      <fieldset className="research-field research-depths" disabled={busy}>
        <legend className="research-label">{t('chat.research.brief.depth')}</legend>
        {DEPTH_ORDER.map((option) => (
          <label key={option} className="research-depth">
            <input
              type="radio"
              name={`${uid}-depth`}
              value={option}
              checked={depth === option}
              onChange={() => setDepth(option)}
            />
            <span className="research-depth-name">{t(DEPTH_LABEL_ID[option])}</span>
            <span className="research-depth-estimate">{t('chat.research.depth.estimate', DEPTH_ESTIMATE[option])}</span>
          </label>
        ))}
      </fieldset>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="btn primary" type="submit" disabled={!canStart}>
          {t('chat.research.brief.start')}
        </button>
        <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
          {t('chat.research.brief.cancel')}
        </button>
      </div>
    </form>
  );
}
