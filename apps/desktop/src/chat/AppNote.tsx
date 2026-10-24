/// A message the app sent for the user, as a short note in the thread (see
/// chat/appPrompt.ts). When it carries text for the model, the note opens to
/// show what was sent: a review's issues, a layout check's findings.

import { Fragment, useState } from 'react';
import { ChevronRight } from '../icons';
import { useT } from '../i18n';

export function AppNote({ messageId, label, body }: { messageId: string; label: string; body: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const text = body.trim();
  if (!text) {
    return (
      <article className="turn app-note" data-message-id={messageId}>
        <p className="app-note-text">{label}</p>
      </article>
    );
  }
  return (
    <Fragment>
      <article className="turn app-note" data-message-id={messageId}>
        <button
          type="button"
          className="app-note-text app-note-toggle"
          aria-expanded={open}
          title={open ? t('chat.appNote.hide') : t('chat.appNote.show')}
          onClick={() => setOpen((was) => !was)}
        >
          {label}
          <ChevronRight className="app-note-chevron" aria-hidden="true" />
        </button>
      </article>
      {open && <div className="app-note-body">{text}</div>}
    </Fragment>
  );
}
