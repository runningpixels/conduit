/// Home's one ask box: describe what you want and the shell decides where it
/// goes (a deck request opens Slides, anything else becomes a new chat).
/// Enter sends, Shift+Enter starts a new line.

import { useEffect, useId, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { useT } from '../i18n';
import { SendIcon } from '../icons';
import type { HomeAction } from './areaInfo';

const CHIPS: ReadonlyArray<{ action: HomeAction; labelId: string }> = [
  { action: 'new-chat', labelId: 'home.ask.chip.chat' },
  { action: 'start-deck', labelId: 'home.ask.chip.deck' },
  { action: 'browse-apps', labelId: 'home.ask.chip.app' },
  { action: 'add-documents', labelId: 'home.ask.chip.documents' },
];

/// The tallest the box grows before it scrolls, in pixels.
const MAX_HEIGHT = 240;

export interface AskBoxProps {
  placeholder: string;
  /** The text in the box; Home keeps it so a draft survives leaving the page. */
  value: string;
  onChange: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onAsk: (text: string) => void;
  onAction: (action: HomeAction) => void;
}

export function AskBox({ placeholder, value: text, onChange: setText, inputRef, onAsk, onAction }: AskBoxProps) {
  const t = useT();
  const hintId = useId();

  // Home is the front door: the cursor is in the box when it opens.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, [inputRef]);

  // Grow with the text, up to a cap.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text, inputRef]);

  const submit = () => {
    const value = text.trim();
    if (value === '') return;
    setText('');
    onAsk(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className="home-ask-wrap">
      <form
        className="home-ask"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={inputRef}
          className="home-ask-input"
          rows={2}
          value={text}
          placeholder={placeholder}
          aria-label={t('home.ask.label')}
          aria-describedby={hintId}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="home-ask-foot">
          <span id={hintId} className="home-ask-hint">
            {t('home.ask.hint')}
          </span>
          <button type="submit" className="home-ask-send" disabled={text.trim() === ''}>
            <span>{t('home.ask.send')}</span>
            <SendIcon />
          </button>
        </div>
      </form>
      <div className="home-chips" role="group" aria-label={t('home.ask.chipsAria')}>
        {CHIPS.map((chip) => (
          <button key={chip.action} type="button" className="home-chip" onClick={() => onAction(chip.action)}>
            {t(chip.labelId)}
          </button>
        ))}
      </div>
    </div>
  );
}
