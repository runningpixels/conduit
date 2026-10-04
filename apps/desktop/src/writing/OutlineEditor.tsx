/// The outline: one row per section (heading, what it must say, a target
/// length). The assistant proposes it (set_outline); the user edits, adds,
/// removes and reorders, then approves it, and the draft is written from it.
/// Edits are committed on blur and on every list change.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { DraftStage, OutlineSection } from '../ipc/contracts';

export interface OutlineEditorProps {
  sections: OutlineSection[];
  stage: DraftStage;
  /** The assistant is working on the draft right now. */
  busy?: boolean;
  onChange: (sections: OutlineSection[]) => void;
  /** Approve outline: shown while the draft is still in its outline stage. */
  onApprove?: () => void;
  /** 'main' is the outline stage's full view; 'dock' is the studio dock's tab. */
  variant?: 'main' | 'dock';
}

interface Row {
  key: string;
  heading: string;
  intent: string;
  /** Kept as typed; parsed on commit. */
  words: string;
}

const MAX_SECTIONS = 30;

function toRows(sections: OutlineSection[], keyFor: () => string): Row[] {
  return sections.map((s) => ({
    key: keyFor(),
    heading: s.heading,
    intent: s.intent,
    words: s.targetWords != null ? String(s.targetWords) : '',
  }));
}

function parseWords(text: string): number | null {
  const n = Number.parseInt(text.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100_000) : null;
}

function toSections(rows: Row[]): OutlineSection[] {
  return rows.map((r) => ({ heading: r.heading.trim(), intent: r.intent.trim(), targetWords: parseWords(r.words) }));
}

function sameAs(rows: Row[], sections: OutlineSection[]): boolean {
  return (
    rows.length === sections.length &&
    rows.every(
      (r, i) =>
        r.heading.trim() === sections[i].heading &&
        r.intent.trim() === sections[i].intent &&
        parseWords(r.words) === sections[i].targetWords,
    )
  );
}

export function OutlineEditor({ sections, stage, busy = false, onChange, onApprove, variant = 'main' }: OutlineEditorProps) {
  const t = useT();
  const counter = useRef(0);
  const nextKey = () => `s-${++counter.current}`;
  const [rows, setRows] = useState<Row[]>(() => toRows(sections, nextKey));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const headings = useRef(new Map<string, HTMLInputElement>());

  // Follow the draft when the outline changes underneath (the assistant
  // revised it). Rows that match keep their keys, so focus stays.
  useEffect(() => {
    // An unnamed row is still being written; it is not part of the outline yet.
    if (sameAs(rowsRef.current.filter((r) => r.heading.trim() !== ''), sections)) return;
    setRows(toRows(sections, nextKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  useEffect(() => {
    if (!focusKey) return;
    headings.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey, rows]);

  const commit = (next: Row[]) => {
    setRows(next);
    // A row without a heading is still being written; it is saved once named.
    onChange(toSections(next.filter((r) => r.heading.trim() !== '')));
  };

  const commitIfChanged = () => {
    const named = rowsRef.current.filter((r) => r.heading.trim() !== '');
    if (!sameAs(named, sections)) onChange(toSections(named));
  };

  const update = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  const add = () => {
    const key = nextKey();
    setRows([...rows, { key, heading: '', intent: '', words: '' }]);
    setFocusKey(key);
  };

  const remove = (index: number) => commit(rows.filter((_, i) => i !== index));

  const named = rows.filter((r) => r.heading.trim() !== '').length;
  const total = toSections(rows).reduce((sum, s) => sum + (s.targetWords ?? 0), 0);

  return (
    <section className="outline-editor" data-variant={variant} aria-label={t('writing.outline.title')}>
      <div className="outline-head">
        <h3 className="outline-title">{t('writing.outline.title')}</h3>
        <p className="outline-hint">
          {stage === 'outline' ? t('writing.outline.hint') : t('writing.outline.hintDraft')}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="outline-empty">{busy ? t('writing.outline.drafting') : t('writing.outline.empty')}</p>
      ) : (
        <ol className="outline-list">
          {rows.map((row, i) => (
            <li key={row.key} className="outline-row">
              <span className="outline-num" aria-hidden="true">
                {i + 1}
              </span>
              <div className="outline-fields">
                <input
                  ref={(el) => {
                    if (el) headings.current.set(row.key, el);
                    else headings.current.delete(row.key);
                  }}
                  className="outline-heading"
                  type="text"
                  value={row.heading}
                  maxLength={200}
                  aria-label={t('writing.outline.headingAria', { n: i + 1 })}
                  placeholder={t('writing.outline.headingPlaceholder')}
                  onChange={(e) => update(row.key, { heading: e.target.value })}
                  onBlur={commitIfChanged}
                />
                <textarea
                  className="outline-intent"
                  rows={2}
                  value={row.intent}
                  maxLength={1000}
                  aria-label={t('writing.outline.intentAria', { n: i + 1 })}
                  placeholder={t('writing.outline.intentPlaceholder')}
                  onChange={(e) => update(row.key, { intent: e.target.value })}
                  onBlur={commitIfChanged}
                />
                <label className="outline-words">
                  <input
                    className="outline-words-input"
                    type="text"
                    inputMode="numeric"
                    value={row.words}
                    maxLength={6}
                    aria-label={t('writing.outline.wordsAria', { n: i + 1 })}
                    onChange={(e) => update(row.key, { words: e.target.value })}
                    onBlur={commitIfChanged}
                  />
                  <span className="outline-words-unit">{t('writing.outline.wordsUnit')}</span>
                </label>
              </div>
              <span className="outline-actions">
                <button
                  type="button"
                  className="storyline-icon-btn"
                  aria-label={t('writing.outline.moveUp', { n: i + 1 })}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  className="storyline-icon-btn"
                  aria-label={t('writing.outline.moveDown', { n: i + 1 })}
                  disabled={i === rows.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <span aria-hidden="true">↓</span>
                </button>
                <button
                  type="button"
                  className="storyline-icon-btn"
                  aria-label={t('writing.outline.remove', { n: i + 1 })}
                  onClick={() => remove(i)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="outline-foot">
        <button type="button" className="btn" disabled={rows.length >= MAX_SECTIONS} onClick={add}>
          {t('writing.outline.add')}
        </button>
        {total > 0 && <span className="outline-total">{t('writing.outline.total', { count: total })}</span>}
        {stage === 'outline' && onApprove && (
          <button
            type="button"
            className="btn primary outline-approve"
            disabled={named === 0 || busy}
            onClick={() => {
              commitIfChanged();
              onApprove();
            }}
          >
            {t('writing.outline.approve')}
          </button>
        )}
      </div>
    </section>
  );
}
