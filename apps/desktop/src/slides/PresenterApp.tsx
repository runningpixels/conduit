/// Root of the presenter window (`index.html?presenter=<deckId>`): loads the
/// deck, asks the presenting window for its state, and follows it.

import { useCallback, useEffect, useState } from 'react';
import { useT } from '../i18n';
import { getDeck } from '../ipc/client';
import type { DeckDetail } from '../ipc/contracts';
import {
  PRESENT_CLOSED_EVENT,
  PRESENT_COMMAND_EVENT,
  PRESENT_HELLO_EVENT,
  PRESENT_STATE_EVENT,
  parseClosedPayload,
  parseStatePayload,
  type PresentStatePayload,
} from './presentCore';
import { closeThisWindow, emitPresent, listenPresentReady } from './presentBus';
import { PresenterView, type PresenterCommand } from './PresenterView';

export function PresenterApp({ deckId }: { deckId: string }) {
  const t = useT();
  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [state, setState] = useState<PresentStatePayload | null>(null);

  const load = useCallback(() => {
    getDeck(deckId).then(
      (d) => {
        setDeck(d);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [deckId]);

  useEffect(() => {
    load();
    // The deck may have been edited while this window was behind.
    window.addEventListener('focus', load);
    return () => window.removeEventListener('focus', load);
  }, [load]);

  useEffect(() => {
    // Only this deck's messages count; anything else is ignored.
    let stopped = false;
    const offs: Array<() => void> = [];
    void Promise.all([
      listenPresentReady(PRESENT_STATE_EVENT, (p) => {
        const parsed = parseStatePayload(p, deckId);
        if (parsed) setState(parsed);
      }),
      listenPresentReady(PRESENT_CLOSED_EVENT, (p) => {
        if (parseClosedPayload(p, deckId)) void closeThisWindow();
      }),
    ]).then((fns) => {
      if (stopped) {
        fns.forEach((f) => f());
        return;
      }
      offs.push(...fns);
      // Subscribed first, then ask, so the reply cannot be missed.
      void emitPresent(PRESENT_HELLO_EVENT, { deckId });
    });
    return () => {
      stopped = true;
      offs.forEach((f) => f());
    };
  }, [deckId]);

  useEffect(() => {
    if (deck) document.title = t('slides.present.windowTitle', { title: deck.title });
  }, [deck, t]);

  const onCommand = useCallback(
    (c: PresenterCommand) => void emitPresent(PRESENT_COMMAND_EVENT, { deckId, ...c }),
    [deckId],
  );

  if (!deck) {
    return (
      <div className="presenter-root presenter-empty" role="status">
        {failed ? t('slides.present.loadFailed') : t('slides.present.loading')}
      </div>
    );
  }
  return <PresenterView deck={deck} state={state} onCommand={onCommand} />;
}
