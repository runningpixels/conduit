/// The quick-ask window (`?ask=1`): one textarea, styled like Home's ask box,
/// with no rail and no app chrome. Enter sends (Rust hides this window, brings
/// the main one forward and the page asks the question as Home does),
/// Shift+Enter adds a line, Esc hides it. Rust also hides it when it loses
/// focus. The window is kept between uses, so the box is cleared on send and
/// takes the cursor whenever the window is shown again.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import { getSettings } from '../ipc/client';
import { applyTheme } from '../theme';
import { hideQuickAsk, submitQuickAsk } from './quickAskIpc';

export function QuickAskApp() {
  const t = useT();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Light or dark as the main app is; re-read each time the box is shown, as
  // the setting may have changed since.
  useEffect(() => {
    const syncTheme = () => {
      void getSettings().then(
        (s) => applyTheme(s.theme),
        () => {},
      );
    };
    const focusBox = () => {
      inputRef.current?.focus({ preventScroll: true });
      syncTheme();
    };
    focusBox();
    window.addEventListener('focus', focusBox);
    return () => window.removeEventListener('focus', focusBox);
  }, []);

  const send = () => {
    const value = text.trim();
    if (value === '') return;
    setText('');
    void submitQuickAsk(value).catch((error) => console.warn('quick ask was not sent', error));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      void hideQuickAsk().catch(() => {});
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  return (
    <main className="quick-ask">
      <div className="home-ask quick-ask-box" data-tauri-drag-region>
        <textarea
          ref={inputRef}
          className="home-ask-input quick-ask-input"
          rows={2}
          value={text}
          placeholder={t('home.quickAsk.placeholder')}
          aria-label={t('home.quickAsk.label')}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="home-ask-hint quick-ask-hint-line">{t('home.quickAsk.hint')}</span>
      </div>
    </main>
  );
}
