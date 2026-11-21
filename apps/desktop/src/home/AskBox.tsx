/// Home's one ask box: describe what you want and the shell decides where it
/// goes (a deck request opens Slides, anything else becomes a new chat).
/// A maker tile picked below readies it for one kind of thing: its chip shows
/// above the text, the placeholder says what to describe, and sending makes
/// that kind. Enter sends, Shift+Enter starts a new line.

import { useEffect, useId, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import { useT } from '../i18n';
import { CloseIcon, SendIcon } from '../icons';
import type { HomeAction } from './areaInfo';
import { madeInChat, type MakeKind } from './makeKinds';
import { MAKE_ICONS } from './MakeTiles';

/// The tallest the box grows before it scrolls, in pixels.
const MAX_HEIGHT = 240;

export interface AskBoxProps {
  placeholder: string;
  /** The text in the box; Home keeps it so a draft survives leaving the page. */
  value: string;
  onChange: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  onAsk: (text: string) => void;
  /** The Research chip: send this text as a Research run in a fresh chat. */
  onResearch: (text: string) => void;
  /** The Automate chip: describe a workflow from this text (the Workflows
   *  page opens on its picker when the box is empty). */
  onAutomate?: (text: string) => void;
  onAction: (action: HomeAction) => void;
  /** The maker tile picked below, if any. */
  kind?: MakeKind | null;
  onClearKind?: () => void;
  /** Send for the picked kind: the text, with the kind's lead-in when a chat makes it. */
  onMake?: (kind: MakeKind, text: string) => void;
}

export function AskBox({
  placeholder,
  value: text,
  onChange: setText,
  inputRef,
  onAsk,
  onResearch,
  onAutomate,
  onAction,
  kind = null,
  onClearKind,
  onMake,
}: AskBoxProps) {
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
    if (kind && onMake) {
      // A deck or a document opens its studio even with nothing typed.
      if (value === '' && madeInChat(kind)) return;
      setText('');
      onMake(kind, value === '' ? '' : madeInChat(kind) ? t(`home.make.${kind}.prefix`, { text: value }) : value);
      return;
    }
    if (value === '') return;
    setText('');
    onAsk(value);
  };
  const canSend = text.trim() !== '' || (kind != null && !madeInChat(kind));

  const research = () => {
    const value = text.trim();
    if (value === '') return;
    setText('');
    onResearch(value);
  };

  const automate = () => {
    const value = text.trim();
    if (value === '' || !onAutomate) {
      onAction('new-workflow');
      return;
    }
    setText('');
    onAutomate(value);
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
        data-kind={kind ?? undefined}
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          submit();
        }}
      >
        {kind && (
          <span className="home-ask-kind" data-kind={kind}>
            <span className="home-ask-kind-icon" aria-hidden="true">
              {MAKE_ICONS[kind]}
            </span>
            {t(`home.make.${kind}.name`)}
            <button
              type="button"
              className="home-ask-kind-clear"
              aria-label={t('home.make.clear', { kind: t(`home.make.${kind}.name`) })}
              title={t('home.make.clear', { kind: t(`home.make.${kind}.name`) })}
              onClick={() => {
                onClearKind?.();
                inputRef.current?.focus();
              }}
            >
              <CloseIcon />
            </button>
          </span>
        )}
        <textarea
          ref={inputRef}
          className="home-ask-input"
          rows={2}
          value={text}
          placeholder={kind ? t(`home.make.${kind}.placeholder`) : placeholder}
          aria-label={t('home.ask.label')}
          aria-describedby={hintId}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="home-ask-foot">
          <span id={hintId} className="home-ask-hint">
            {t('home.ask.hint')}
          </span>
          <button type="submit" className="home-ask-send" disabled={!canSend}>
            <span>{t('home.ask.send')}</span>
            <SendIcon />
          </button>
        </div>
      </form>
      <div className="home-chips" role="group" aria-label={t('home.ask.chipsAria')}>
        {/* Making things is the tiles below; these are the other ways in. */}
        <button type="button" className="home-chip" onClick={() => onAction('new-chat')}>
          {t('home.ask.chip.chat')}
        </button>
        {/* With text, Automate drafts a workflow from it; without, it opens the picker. */}
        <button type="button" className="home-chip" onClick={automate}>
          {t('home.ask.chip.automate')}
        </button>
        {/* Research needs a question to research, so it waits for text. */}
        <button
          type="button"
          className="home-chip"
          disabled={text.trim() === ''}
          title={text.trim() === '' ? t('home.ask.chip.researchHint') : undefined}
          onClick={research}
        >
          {t('home.ask.chip.research')}
        </button>
        <button type="button" className="home-chip" onClick={() => onAction('add-documents')}>
          {t('home.ask.chip.documents')}
        </button>
      </div>
    </div>
  );
}
