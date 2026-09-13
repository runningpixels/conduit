import { useEffect, useState } from 'react';
import { supportedModes, THEME_CHANGED_EVENT } from '../shell/uiPrefs';
import type { Mode } from './registry';

/** The modes the active theme can render, kept current across theme changes. */
export function useSupportedModes(): readonly Mode[] {
  const [modes, setModes] = useState<readonly Mode[]>(() => supportedModes());
  useEffect(() => {
    const onChange = () => setModes(supportedModes());
    window.addEventListener(THEME_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(THEME_CHANGED_EVENT, onChange);
  }, []);
  return modes;
}
