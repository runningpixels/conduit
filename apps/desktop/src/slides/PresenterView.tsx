/// The presenter window's screen: current slide, next slide, speaker notes,
/// timer and clock. Presentational; `PresenterApp` feeds it the deck and the
/// state received from the presenting window, and turns `onCommand` into events.

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { ArtifactColorScheme } from '../artifacts/HtmlArtifactRenderer';
import type { DeckDetail } from '../ipc/contracts';
import { DeckFrame } from './DeckFrame';
import { formatElapsed, presentKey, type PresentCommandPayload, type PresentStatePayload } from './presentCore';

export const NOTES_SIZE_KEY = 'conduit.presenter.notesSize';
export const NOTES_SIZE_MIN = 16;
export const NOTES_SIZE_MAX = 72;
const NOTES_SIZE_DEFAULT = 28;
const NOTES_SIZE_STEP = 4;

function readNotesSize(): number {
  try {
    const n = Number.parseInt(window.localStorage.getItem(NOTES_SIZE_KEY) ?? '', 10);
    if (Number.isFinite(n)) return Math.max(NOTES_SIZE_MIN, Math.min(NOTES_SIZE_MAX, n));
  } catch {
    /* storage unavailable */
  }
  return NOTES_SIZE_DEFAULT;
}

export type PresenterCommand = Omit<PresentCommandPayload, 'deckId'>;

export interface PresenterViewProps {
  deck: DeckDetail;
  /** Null until the presenting window has answered. */
  state: PresentStatePayload | null;
  colorScheme?: ArtifactColorScheme;
  onCommand: (command: PresenterCommand) => void;
}

export function PresenterView({ deck, state, colorScheme = 'dark', onCommand }: PresenterViewProps) {
  const t = useT();
  const count = deck.slides.length;
  const index = Math.max(0, Math.min(Math.max(0, count - 1), state?.index ?? 0));
  const slide = deck.slides[index];
  const hasNext = index < count - 1;
  const [size, setSize] = useState(readNotesSize);
  const [now, setNow] = useState(() => Date.now());
  // The timer: `origin` is when it reads zero; pausing freezes `now`.
  const [origin, setOrigin] = useState<number | null>(null);
  const [pausedAt, setPausedAt] = useState<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (origin == null && state) setOrigin(state.startedAt);
  }, [origin, state]);

  const changeSize = (delta: number) => {
    const next = Math.max(NOTES_SIZE_MIN, Math.min(NOTES_SIZE_MAX, size + delta));
    setSize(next);
    try {
      window.localStorage.setItem(NOTES_SIZE_KEY, String(next));
    } catch {
      /* not remembered */
    }
  };

  const cmdRef = useRef({ onCommand, count });
  cmdRef.current = { onCommand, count };
  useEffect(() => {
    let digits = '';
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const result = presentKey(e.key, digits);
      digits = result.buffer;
      const a = result.action;
      if (!a || a === 'presenter') return;
      e.preventDefault();
      const { onCommand: send, count: n } = cmdRef.current;
      if (a.type === 'next' || a.type === 'prev' || a.type === 'black') send({ action: a.type });
      else if (a.type === 'goto') send({ action: 'goto', index: a.index });
      else if (a.type === 'first') send({ action: 'goto', index: 0 });
      else if (a.type === 'last') send({ action: 'goto', index: n - 1 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const elapsed = origin == null ? 0 : (pausedAt ?? now) - origin;
  const notes = slide?.notes?.trim() ?? '';
  const clock = new Date(now).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="presenter-root" data-black={state?.black ? 'true' : undefined}>
      <div className="presenter-main">
        <section className="presenter-current" aria-label={t('slides.present.currentAria')}>
          <div className="presenter-frame">
            <DeckFrame deck={deck} index={index} mode="stage" colorScheme={colorScheme} present />
            {state?.black && <div className="presenter-badge">{t('slides.present.blackOn')}</div>}
            {state?.ended && <div className="presenter-badge">{t('slides.present.end')}</div>}
          </div>
          <div className="presenter-controls">
            <button type="button" className="btn" onClick={() => onCommand({ action: 'prev' })}>
              {t('slides.present.prev')}
            </button>
            <span className="presenter-count" data-testid="presenter-count">
              {t('slides.present.countLong', { n: index + 1, total: count })}
            </span>
            <button type="button" className="btn" onClick={() => onCommand({ action: 'next' })}>
              {t('slides.present.next')}
            </button>
            <button
              type="button"
              className="btn"
              aria-pressed={state?.black === true}
              onClick={() => onCommand({ action: 'black' })}
            >
              {t('slides.present.black')}
            </button>
            <button type="button" className="btn presenter-end" onClick={() => onCommand({ action: 'exit' })}>
              {t('slides.present.endShow')}
            </button>
          </div>
        </section>
        <aside className="presenter-side">
          <div className="presenter-timer">
            <span className="presenter-clock" data-testid="presenter-timer" aria-label={t('slides.present.timerAria')}>
              {formatElapsed(elapsed)}
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (pausedAt == null) setPausedAt(Date.now());
                else {
                  setOrigin((o) => (o ?? pausedAt) + (Date.now() - pausedAt));
                  setPausedAt(null);
                }
              }}
            >
              {pausedAt == null ? t('slides.present.pause') : t('slides.present.resume')}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setOrigin(Date.now());
                setPausedAt(null);
              }}
            >
              {t('slides.present.reset')}
            </button>
            <span className="presenter-wall" data-testid="presenter-wall">
              {clock}
            </span>
          </div>
          <div className="presenter-next" aria-label={t('slides.present.nextAria')}>
            <div className="presenter-label">{t('slides.present.nextLabel')}</div>
            {hasNext ? (
              <div className="presenter-next-frame">
                <DeckFrame deck={deck} index={index + 1} mode="stage" colorScheme={colorScheme} present />
              </div>
            ) : (
              <div className="presenter-next-end">{t('slides.present.endOfShow')}</div>
            )}
          </div>
          <div className="presenter-notes-head">
            <span className="presenter-label">{t('slides.present.notes')}</span>
            <span className="presenter-size">
              <button
                type="button"
                className="btn"
                aria-label={t('slides.present.smaller')}
                disabled={size <= NOTES_SIZE_MIN}
                onClick={() => changeSize(-NOTES_SIZE_STEP)}
              >
                {t('slides.present.smallerShort')}
              </button>
              <button
                type="button"
                className="btn"
                aria-label={t('slides.present.larger')}
                disabled={size >= NOTES_SIZE_MAX}
                onClick={() => changeSize(NOTES_SIZE_STEP)}
              >
                {t('slides.present.largerShort')}
              </button>
            </span>
          </div>
          <div className="presenter-notes" data-testid="presenter-notes" style={{ fontSize: `${size}px` }}>
            {notes !== '' ? notes : <span className="presenter-notes-empty">{t('slides.present.noNotes')}</span>}
          </div>
        </aside>
      </div>
    </div>
  );
}
