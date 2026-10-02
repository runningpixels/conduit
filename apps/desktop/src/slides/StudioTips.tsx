/// First-time tips: a small card at the bottom of the stage, three steps,
/// shown once after the first build finishes. Dismissal is remembered.

import { useState } from 'react';
import { useT } from '../i18n';

export const TIPS_STORAGE_KEY = 'conduit:slides-tips-v1';

const TIPS: readonly string[] = ['slides.tips.edit', 'slides.tips.script', 'slides.tips.yours'];

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(TIPS_STORAGE_KEY) != null;
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(TIPS_STORAGE_KEY, '1');
  } catch {
    /* storage may be blocked; the card then shows again next time */
  }
}

export function StudioTips({ visible }: { visible: boolean }) {
  const t = useT();
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!visible || dismissed) return null;

  const last = step >= TIPS.length - 1;
  const dismiss = () => {
    writeDismissed();
    setDismissed(true);
  };

  return (
    <aside className="studio-tips" aria-label={t('slides.tips.aria')}>
      <span className="studio-tips-count">{t('slides.tips.count', { n: step + 1, m: TIPS.length })}</span>
      <p className="studio-tips-text">{t(TIPS[step])}</p>
      <button type="button" className="btn" onClick={last ? dismiss : () => setStep(step + 1)}>
        {last ? t('slides.tips.done') : t('slides.tips.next')}
      </button>
    </aside>
  );
}
