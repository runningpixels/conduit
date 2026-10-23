/// Stop and Redirect for one running helper. Redirect opens a small text field:
/// Enter sends it, Escape closes it. The helper may finish at any moment, so a
/// failed command shows its reason inline for a few seconds.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import { redirectAgentCall, stopAgentCall } from '../ipc/client';

const ERROR_MS = 5000;

export function HelperControls({ callId, name }: { callId: string; name: string }) {
  const t = useT();
  const [redirecting, setRedirecting] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const field = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );
  useEffect(() => {
    if (redirecting) field.current?.focus();
  }, [redirecting]);

  function fail() {
    setError(t('chat.handoff.controlFailed', { name }));
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setError(null), ERROR_MS);
  }

  async function stop() {
    setBusy(true);
    try {
      await stopAgentCall(callId);
      setError(null);
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const message = text.trim();
    if (!message) return;
    setBusy(true);
    try {
      await redirectAgentCall(callId, message);
      setText('');
      setRedirecting(false);
      setError(null);
    } catch {
      fail();
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      // Close the field only: not the panel, dialog or page around it.
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setRedirecting(false);
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <div className="helper-controls">
      <div className="helper-controls-row">
        <button
          type="button"
          className="btn ghost helper-btn"
          disabled={busy}
          aria-label={t('chat.handoff.stopAria', { name })}
          onClick={() => void stop()}
        >
          {t('chat.handoff.stop')}
        </button>
        <button
          type="button"
          className="btn ghost helper-btn"
          aria-expanded={redirecting}
          aria-label={t('chat.handoff.redirectAria', { name })}
          onClick={() => setRedirecting((v) => !v)}
        >
          {t('chat.handoff.redirect')}
        </button>
      </div>
      {redirecting ? (
        <div className="helper-redirect">
          <input
            ref={field}
            type="text"
            value={text}
            placeholder={t('chat.handoff.redirectPlaceholder', { name })}
            aria-label={t('chat.handoff.redirectField', { name })}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button
            type="button"
            className="btn helper-btn"
            disabled={busy || text.trim() === ''}
            onClick={() => void send()}
          >
            {t('chat.handoff.redirectSend')}
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="helper-error" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}
