/// The theme picker's options: built-in themes, then saved ones (made by the
/// model or the user), then the deck's own theme if it is in neither list.

import type { DeckDetail, SlideTheme } from '../ipc/contracts';
import { STARTER_THEMES } from './themes';

export interface ThemeChoice {
  value: string;
  label: string;
  /** Null for a theme the app can't re-apply (the deck's own, unknown one). */
  css: string | null;
}

export function buildThemeChoices(
  deck: Pick<DeckDetail, 'themeName'> | null,
  savedThemes: readonly SlideTheme[],
): ThemeChoice[] {
  const choices: ThemeChoice[] = STARTER_THEMES.map((th) => ({ value: th.name, label: th.label, css: th.css }));
  for (const saved of savedThemes) {
    if (!choices.some((c) => c.value.toLowerCase() === saved.name.toLowerCase())) {
      choices.push({ value: saved.name, label: saved.name, css: saved.css });
    }
  }
  if (deck && !choices.some((c) => c.value === deck.themeName)) {
    choices.push({ value: deck.themeName, label: deck.themeName, css: null });
  }
  return choices;
}
