/// Full-screen presenting: one deck frame on black, driven by keys and clicks,
/// and the source of truth that the presenter window follows over Tauri events.
/// A portal to <body>, so the studio underneath (and the one mounted chat) is
/// never re-parented.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import type { ArtifactColorScheme } from '../artifacts/HtmlArtifactRenderer';
import type { DeckDetail } from '../ipc/contracts';
import { DeckFrame } from './DeckFrame';
import {
  PRESENT_CLOSED_EVENT,
  PRESENT_COMMAND_EVENT,
  PRESENT_HELLO_EVENT,
  PRESENT_STATE_EVENT,
  clampIndex,
  commandToAction,
  initialPresentState,
  parseCommandPayload,
  parseHelloPayload,
  presentKey,
  reducePresent,
  type PresentAction,
  type PresentState,
  type PresentStatePayload,
} from './presentCore';
import {
  emitPresent,
  enterFullscreen,
  hasSecondMonitor,
  listenPresent,
  openPresenterWindow,
} from './presentBus';

export const PRESENT_IDLE_MS = 2000;

export interface PresentationViewProps {
  deck: DeckDetail;
  /** Slide to start on (0 for "from the start"). */
  startIndex: number;
  colorScheme: ArtifactColorScheme;
  onExit: () => void;
}

export function PresentationView({ deck, startIndex, colorScheme, onExit }: PresentationViewProps) {
  const t = useT();
  const count = deck.slides.length;
  const [state, setState] = useState<PresentState>(() => initialPresentState(startIndex, count));
  const stateRef = useRef(state);
  const [idle, setIdle] = useState(true);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startedAt = useRef(Date.now());
  const digits = useRef('');
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const exitRef = useRef(onExit);
  exitRef.current = onExit;

  const apply = useCallback((action: PresentAction) => {
    const step = reducePresent(stateRef.current, action, deckRef.current.slides.length);
    stateRef.current = step.state;
    setState(step.state);
    if (step.exit) exitRef.current();
  }, []);

  // The deck is live: keep the index in range if slides were removed.
  useEffect(() => {
    const clamped = clampIndex(stateRef.current.index, count);
    if (clamped !== stateRef.current.index) {
      stateRef.current = { ...stateRef.current, index: clamped };
      setState(stateRef.current);
    }
  }, [count]);

  const openPresenter = useCallback(() => {
    const d = deckRef.current;
    void openPresenterWindow(d.id, t('slides.present.windowTitle', { title: d.title }));
  }, [t]);
  const openPresenterRef = useRef(openPresenter);
  openPresenterRef.current = openPresenter;

  // Full screen and the presenter window's lifetime. Cleanup is deferred a tick
  // so a StrictMode remount does not leave full screen and re-enter it.
  const alive = useRef(false);
  const restore = useRef<Promise<() => void> | null>(null);
  useEffect(() => {
    alive.current = true;
    if (!restore.current) {
      restore.current = enterFullscreen();
      void hasSecondMonitor().then((yes) => {
        if (yes && alive.current) openPresenterRef.current();
      });
    }
    return () => {
      alive.current = false;
      setTimeout(() => {
        if (alive.current) return;
        void restore.current?.then((fn) => fn());
        restore.current = null;
        void emitPresent(PRESENT_CLOSED_EVENT, { deckId: deckRef.current.id });
      }, 0);
    };
  }, []);

  // Keep the presenter window in step.
  const publish = useCallback(() => {
    const payload: PresentStatePayload = {
      deckId: deckRef.current.id,
      ...stateRef.current,
      startedAt: startedAt.current,
    };
    void emitPresent(PRESENT_STATE_EVENT, payload);
  }, []);
  useEffect(() => {
    publish();
  }, [state, publish]);
  useEffect(() => {
    const id = deck.id;
    const offHello = listenPresent(PRESENT_HELLO_EVENT, (p) => {
      if (parseHelloPayload(p, id)) publish();
    });
    const offCommand = listenPresent(PRESENT_COMMAND_EVENT, (p) => {
      const cmd = parseCommandPayload(p, id);
      if (cmd) apply(commandToAction(cmd));
    });
    return () => {
      offHello();
      offCommand();
    };
  }, [deck.id, apply, publish]);

  // Keys. Capture phase on window: nothing in the studio sees them while presenting.
  useEffect(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return;
      e.preventDefault();
      e.stopPropagation();
      const result = presentKey(e.key, digits.current);
      digits.current = result.buffer;
      // Any key while black only un-blacks, except the ones that toggle or open.
      if (result.action === 'presenter') openPresenterRef.current();
      else if (result.action) apply(result.action);
      else if (stateRef.current.black && result.buffer === '') apply({ type: 'next' });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [apply]);

  // Cursor and control bar: shown on movement, gone after two idle seconds.
  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setIdle(true), PRESENT_IDLE_MS);
  }, []);
  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  const index = clampIndex(state.index, count);
  const view = (
    <div
      className="present-root"
      data-idle={idle ? 'true' : 'false'}
      data-black={state.black ? 'true' : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={t('slides.present.aria')}
      onMouseMove={wake}
    >
      <div className="present-stage">
        <DeckFrame deck={deck} index={index} mode="stage" colorScheme={colorScheme} present />
      </div>
      <div
        className="present-hit"
        data-testid="present-hit"
        onClick={() => apply({ type: 'next' })}
        onContextMenu={(e) => {
          e.preventDefault();
          apply({ type: 'prev' });
        }}
      />
      {state.ended && !state.black && (
        <div className="present-end" aria-live="polite">
          {t('slides.present.end')}
        </div>
      )}
      {state.black && <div className="present-black" aria-hidden="true" />}
      <div
        className="present-bar"
        data-visible={idle ? 'false' : 'true'}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <button type="button" aria-label={t('slides.present.prev')} onClick={() => apply({ type: 'prev' })}>
          ←
        </button>
        <span className="present-bar-count">{t('slides.present.count', { n: index + 1, total: count })}</span>
        <button type="button" aria-label={t('slides.present.next')} onClick={() => apply({ type: 'next' })}>
          →
        </button>
        <button type="button" onClick={openPresenter}>
          {t('slides.present.presenterView')}
        </button>
        <button type="button" onClick={() => apply({ type: 'exit' })}>
          {t('slides.present.exit')}
        </button>
      </div>
    </div>
  );
  return createPortal(view, document.body);
}
