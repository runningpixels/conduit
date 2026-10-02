/// The studio's top bar: back to the deck list, the deck's title, the four
/// steps a deck goes through, and the theme. Props-driven.

import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import type { DeckDetail } from '../ipc/contracts';
import type { ThemeChoice } from './themeChoices';

export type StudioStep = 'story' | 'slides' | 'polish' | 'present';

export interface StudioHeaderProps {
  deck: DeckDetail;
  /** Name of the deck tool the model is running right now, if any. */
  busyTool: string | null;
  themes: readonly ThemeChoice[];
  onBack: () => void;
  onRename: (title: string) => void;
  onSetTheme: (name: string, css: string) => void;
  /** The deck started as a request in an ordinary chat. */
  madeFromChat: boolean;
  onUndoStart: () => void;
}

const STEPS: ReadonlyArray<{ step: StudioStep; labelId: string }> = [
  { step: 'story', labelId: 'slides.studio.step.story' },
  { step: 'slides', labelId: 'slides.studio.step.slides' },
  { step: 'polish', labelId: 'slides.studio.step.polish' },
  { step: 'present', labelId: 'slides.studio.step.present' },
];

/** Storyline stage is Story; building slides is Slides; anything else is Polish. */
export function currentStudioStep(deck: Pick<DeckDetail, 'stage'>, busy: boolean): StudioStep {
  if (deck.stage === 'storyline') return 'story';
  return busy ? 'slides' : 'polish';
}

export function StudioHeader({
  deck,
  busyTool,
  themes,
  onBack,
  onRename,
  onSetTheme,
  madeFromChat,
  onUndoStart,
}: StudioHeaderProps) {
  const t = useT();
  const [titleDraft, setTitleDraft] = useState(deck.title);
  useEffect(() => {
    setTitleDraft(deck.title);
  }, [deck.title, deck.id]);

  const busy = busyTool != null;
  const current = currentStudioStep(deck, busy);

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next === '' || next === deck.title) {
      setTitleDraft(deck.title);
      return;
    }
    onRename(next);
  };

  return (
    <header className="studio-head">
      <div className="studio-head-row">
        <button type="button" className="btn studio-back" onClick={onBack}>
          <span aria-hidden="true">←</span> {t('slides.studio.back')}
        </button>
        <input
          className="deck-title-input studio-title"
          type="text"
          value={titleDraft}
          maxLength={120}
          aria-label={t('slides.workspace.titleAria')}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              setTitleDraft(deck.title);
              e.currentTarget.blur();
            }
          }}
        />
        {madeFromChat && deck.slides.length === 0 && (
          <span className="studio-made">
            <span>{t('slides.studio.madeFromChat')}</span>
            <button type="button" className="studio-made-undo" onClick={onUndoStart}>
              {t('slides.studio.undo')}
            </button>
          </span>
        )}
        {busy && (
          <span className="deck-updating" role="status">
            {t('slides.workspace.updating')}
          </span>
        )}
        <label className="deck-theme">
          <span className="deck-theme-label">{t('slides.workspace.theme')}</span>
          <select
            className="deck-theme-select"
            value={deck.themeName}
            onChange={(e) => {
              const choice = themes.find((c) => c.value === e.target.value);
              if (choice?.css) onSetTheme(choice.value, choice.css);
            }}
          >
            {themes.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ol className="studio-steps" aria-label={t('slides.studio.stepsAria')}>
        {STEPS.map(({ step, labelId }) => (
          <li
            key={step}
            className="studio-step"
            data-step={step}
            data-current={step === current ? 'true' : undefined}
            data-disabled={step === 'present' ? 'true' : undefined}
            aria-current={step === current ? 'step' : undefined}
            title={step === 'present' ? t('slides.studio.comingNext') : undefined}
          >
            {t(labelId)}
          </li>
        ))}
      </ol>
    </header>
  );
}
