/// The storyline: one line per slide, edited before any slide exists. The
/// model drafts it (set_storyline); the user reorders and rewrites, then
/// presses Build slides. Edits are committed on blur and on every list change.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { StorylineItem } from '../ipc/contracts';

export interface StorylineEditorProps {
  items: StorylineItem[];
  /** The model is working on the deck right now. */
  busy?: boolean;
  onChange: (items: StorylineItem[]) => void;
  onBuild: () => void;
}

interface Draft {
  key: string;
  id: string;
  text: string;
}

function toDrafts(items: StorylineItem[], keyFor: () => string): Draft[] {
  return items.map((i) => ({ key: i.id || keyFor(), id: i.id, text: i.text }));
}

export function StorylineEditor({ items, busy = false, onChange, onBuild }: StorylineEditorProps) {
  const t = useT();
  const counter = useRef(0);
  const nextKey = () => `new-${++counter.current}`;
  const [drafts, setDrafts] = useState<Draft[]>(() => toDrafts(items, nextKey));
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const inputs = useRef(new Map<string, HTMLTextAreaElement>());

  // Follow the deck when it changes underneath (the model rewrote it, or the
  // server filled in ids). Keep the rows' keys when only ids changed, so the
  // input being typed in keeps focus.
  useEffect(() => {
    const current = draftsRef.current;
    const same = current.length === items.length && current.every((d, i) => d.text === items[i].text);
    if (same) {
      if (current.some((d, i) => d.id !== items[i].id)) {
        setDrafts(current.map((d, i) => ({ ...d, id: items[i].id })));
      }
      return;
    }
    setDrafts(toDrafts(items, nextKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  useEffect(() => {
    if (!focusKey) return;
    inputs.current.get(focusKey)?.focus();
    setFocusKey(null);
  }, [focusKey, drafts]);

  const commit = (next: Draft[]) => {
    setDrafts(next);
    onChange(next.map((d) => ({ id: d.id, text: d.text })));
  };

  const dirty = () =>
    draftsRef.current.length !== items.length || draftsRef.current.some((d, i) => d.text !== items[i].text);

  const setText = (key: string, text: string) =>
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, text } : d)));

  const move = (index: number, delta: number) => {
    const next = [...drafts];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  const add = () => {
    const key = nextKey();
    setDrafts([...drafts, { key, id: '', text: '' }]);
    setFocusKey(key);
  };

  const remove = (index: number) => commit(drafts.filter((_, i) => i !== index));

  const filled = drafts.filter((d) => d.text.trim() !== '').length;

  return (
    <section className="storyline" aria-label={t('slides.storyline.title')}>
      <div className="storyline-head">
        <h3 className="storyline-title">{t('slides.storyline.title')}</h3>
        <p className="storyline-hint">{t('slides.storyline.hint')}</p>
      </div>
      {drafts.length === 0 ? (
        <p className="storyline-empty">{t('slides.storyline.empty')}</p>
      ) : (
        <ol className="storyline-list">
          {drafts.map((d, i) => (
            <li key={d.key} className="storyline-row">
              <span className="storyline-num" aria-hidden="true">
                {i + 1}
              </span>
              {/* A textarea so a long line wraps instead of being cut off;
                  Enter still starts the next line of the storyline. */}
              <textarea
                ref={(el) => {
                  if (el) inputs.current.set(d.key, el);
                  else inputs.current.delete(d.key);
                }}
                className="storyline-input"
                rows={1}
                value={d.text}
                maxLength={300}
                aria-label={t('slides.storyline.lineAria', { n: i + 1 })}
                placeholder={t('slides.storyline.linePlaceholder')}
                onChange={(e) => setText(d.key, e.target.value)}
                onBlur={() => {
                  if (dirty()) commit(draftsRef.current);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    if (dirty()) commit(draftsRef.current);
                    add();
                  }
                }}
              />
              <span className="storyline-actions">
                <button
                  type="button"
                  className="storyline-icon-btn"
                  aria-label={t('slides.storyline.moveUp', { n: i + 1 })}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  className="storyline-icon-btn"
                  aria-label={t('slides.storyline.moveDown', { n: i + 1 })}
                  disabled={i === drafts.length - 1}
                  onClick={() => move(i, 1)}
                >
                  <span aria-hidden="true">↓</span>
                </button>
                <button
                  type="button"
                  className="storyline-icon-btn"
                  aria-label={t('slides.storyline.delete', { n: i + 1 })}
                  onClick={() => remove(i)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className="storyline-foot">
        <button type="button" className="btn" disabled={drafts.length >= 60} onClick={add}>
          {t('slides.storyline.add')}
        </button>
        <button type="button" className="btn primary" disabled={filled === 0 || busy} onClick={onBuild}>
          {t('slides.storyline.build')}
        </button>
      </div>
    </section>
  );
}
