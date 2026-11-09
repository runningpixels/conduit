import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MicIcon, StopIcon } from '../icons';
import { useT } from '../i18n';
import {
  dictationCancel,
  dictationStart,
  dictationStatus,
  dictationStop,
  type DictationStatus,
} from '../ipc/client';
import { translateError } from '../ipc/errors';
import { clock } from '../lib/dictation';

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';

/**
 * The composer's microphone. Click to start, click again to stop; the
 * recording goes to the user's own transcription provider and the text comes
 * back through `onText`. Escape while recording discards it.
 *
 * Disabled, with the reason as its title, when no saved key can transcribe or
 * local-only mode is on. `refreshKey` changes when settings that decide that
 * change (active provider, keys, local-only), so the status is asked again.
 */
export function DictationButton({
  onText,
  refreshKey,
}: {
  onText: (text: string) => void;
  refreshKey?: string;
}) {
  const t = useT();
  const [status, setStatus] = useState<DictationStatus | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const phaseRef = useRef<Phase>('idle');
  phaseRef.current = phase;
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const loadRef = useRef<() => void>(() => {});
  useEffect(() => {
    let live = true;
    const load = () =>
      void Promise.resolve()
        .then(() => dictationStatus())
        .then((s) => live && setStatus(s ?? null))
        .catch(() => live && setStatus(null));
    loadRef.current = load;
    load();
    // A key saved in Settings doesn't change any prop here, so ask again when
    // the window regains focus and when the pointer reaches the button.
    window.addEventListener('focus', load);
    return () => {
      live = false;
      loadRef.current = () => {};
      window.removeEventListener('focus', load);
    };
  }, [refreshKey]);

  // Leaving the composer while recording discards the recording.
  useEffect(
    () => () => {
      if (phaseRef.current === 'recording' || phaseRef.current === 'starting') void dictationCancel();
    },
    [],
  );

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 8000);
    return () => window.clearTimeout(timer);
  }, [error]);

  const stop = useCallback(async () => {
    if (phaseRef.current !== 'recording') return;
    setPhase('transcribing');
    try {
      const text = await dictationStop();
      if (text.trim()) onTextRef.current(text);
      else setError(t('error.dictation.nothingHeard'));
    } catch (e) {
      setError(translateError(e, t));
    } finally {
      setPhase('idle');
    }
  }, [t]);

  const cancel = useCallback(() => {
    if (phaseRef.current !== 'recording') return;
    setPhase('idle');
    void dictationCancel();
  }, []);

  // While recording: the level drives the ring, the clock ticks, Escape
  // discards, and reaching the length limit stops and transcribes.
  useEffect(() => {
    if (phase !== 'recording') return;
    const startedAt = Date.now();
    setSeconds(0);
    const tick = window.setInterval(() => setSeconds((Date.now() - startedAt) / 1000), 250);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    let unlisten: Array<() => void> = [];
    let live = true;
    void Promise.all([
      listen<number>('dictation-level', (e) => {
        buttonRef.current?.style.setProperty('--dictation-level', String(e.payload));
      }),
      listen('dictation-full', () => void stop()),
    ])
      .then((fns) => {
        if (live) unlisten = fns;
        else fns.forEach((f) => f());
      })
      .catch(() => {});
    return () => {
      live = false;
      window.clearInterval(tick);
      window.removeEventListener('keydown', onKey, true);
      unlisten.forEach((f) => f());
      buttonRef.current?.style.removeProperty('--dictation-level');
    };
  }, [phase, cancel, stop]);

  const start = async () => {
    setError(null);
    setPhase('starting');
    try {
      await dictationStart();
      setPhase((p) => (p === 'starting' ? 'recording' : p));
    } catch (e) {
      setPhase('idle');
      setError(translateError(e, t));
    }
  };

  if (!status) return null;

  const blocked = status.blocked;
  const idleTitle =
    blocked === 'localOnly'
      ? t('chat.composer.dictation.localOnly')
      : blocked === 'noProvider'
        ? t('chat.composer.dictation.noProvider')
        : t('chat.composer.dictation.start', { provider: status.providerName ?? '' });

  let label: string;
  let content: ReactNode;
  if (phase === 'recording') {
    label = t('chat.composer.dictation.stop');
    content = (
      <>
        <StopIcon />
        <span className="composer-dictation-clock">{clock(seconds)}</span>
      </>
    );
  } else if (phase === 'transcribing') {
    label = t('chat.composer.dictation.transcribing');
    content = <span className="composer-dictation-spinner" aria-hidden />;
  } else {
    label = idleTitle;
    content = <MicIcon />;
  }

  return (
    <span
      className="composer-dictation"
      onPointerEnter={() => {
        if (phase === 'idle') loadRef.current();
      }}
    >
      {error ? (
        <span className="composer-dictation-error" role="status">
          {error}
        </span>
      ) : null}
      <button
        ref={buttonRef}
        className="composer-tool composer-dictation-button"
        type="button"
        data-icon-only="true"
        data-phase={phase}
        aria-pressed={phase === 'recording'}
        aria-label={label}
        title={phase === 'recording' ? `${label} · ${t('chat.composer.dictation.escToDiscard')}` : label}
        disabled={blocked !== null || phase === 'starting' || phase === 'transcribing'}
        onClick={() => void (phase === 'recording' ? stop() : start())}
      >
        {content}
      </button>
    </span>
  );
}
