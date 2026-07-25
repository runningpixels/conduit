import { useEffect, useState, type RefObject } from 'react';
import { COMPOSER_MAX_HEIGHT_PX } from './composerTypes';

export function useComposerAutosize(
  textareaRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  const [capped, setCapped] = useState(false);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const scrollHeight = ta.scrollHeight;
    const isCapped = scrollHeight > COMPOSER_MAX_HEIGHT_PX;
    ta.style.height = `${Math.min(scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
    ta.style.overflowY = isCapped ? 'auto' : 'hidden';
    ta.dataset.capped = isCapped ? 'true' : 'false';
    setCapped(isCapped);
  }, [textareaRef, value]);

  return { capped };
}
