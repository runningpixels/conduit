import { useMemo } from 'react';
import { SpeakerIcon, StopIcon } from '../icons';
import { useLocale, useT } from '../i18n';
import { readAloud, speechLanguage, stopReadAloud, useReadAloud } from '../lib/readAloud';

/** The language's name in the UI language, e.g. "German" or "Deutsch". */
function languageName(lang: string, uiLocale: string): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(lang) ?? lang;
  } catch {
    return lang;
  }
}

/**
 * Read aloud / Stop for one finished reply, spoken with the system's own
 * voices. Hidden when the webview has no speech engine or no voices at all;
 * disabled, with the reason, when no voice speaks the reply's language.
 */
export function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const t = useT();
  const { locale } = useLocale();
  const { supported, speaking, hasVoice } = useReadAloud(id);
  const lang = useMemo(() => speechLanguage(text, locale), [text, locale]);
  if (!supported || !text.trim()) return null;

  if (speaking) {
    return (
      <button
        type="button"
        className="act"
        aria-pressed="true"
        aria-label={t('chat.assistant.actions.stopReadingLabel')}
        title={t('chat.assistant.actions.stopReadingLabel')}
        onClick={stopReadAloud}
      >
        <StopIcon />
        {t('chat.assistant.actions.stopReading')}
      </button>
    );
  }

  const available = hasVoice(lang);
  const title = available
    ? t('chat.assistant.actions.readAloudLabel')
    : t('chat.assistant.actions.noVoice', { language: languageName(lang, locale) });
  return (
    <button
      type="button"
      className="act"
      aria-pressed="false"
      aria-label={title}
      title={title}
      disabled={!available}
      onClick={() => readAloud(id, text, lang)}
    >
      <SpeakerIcon />
      {t('chat.assistant.actions.readAloud')}
    </button>
  );
}
