import { describe, expect, it } from 'vitest';
import type { AppSummary, StarterAppInfo } from '../ipc/contracts';
import de from '../i18n/messages/de.json';
import en from '../i18n/messages/en.json';
import { loadStarterTexts, localizeStarterApps, needsStarterTexts, withLocalStarterNames } from './starterNames';

const starters = [{ id: 'pomodoro-timer', ideaId: 'pomodoroTimer' }] as StarterAppInfo[];
const app = (extra: Partial<AppSummary>) =>
  ({ id: 'a1', name: 'x', category: 'tools', hosts: [], ...extra }) as unknown as AppSummary;
/** German `t` over the real catalog, enough for the Ideas keys. */
const tDe = ((key: string) => (de as Record<string, string>)[key] ?? key) as never;

// Bug #8: a starter added in English kept "Pomodoro timer" after switching to German.
describe('starter app names follow the language', () => {
  const added = app({
    starterId: 'pomodoro-timer',
    name: en['ideas.item.pomodoroTimer.title'],
    description: en['ideas.item.pomodoroTimer.blurb'],
  });

  it('shows an untouched starter in the current language', async () => {
    const [shown] = await withLocalStarterNames([added], starters, tDe);
    expect(shown.name).toBe(de['ideas.item.pomodoroTimer.title']);
    expect(shown.description).toBe(de['ideas.item.pomodoroTimer.blurb']);
    expect(shown.name).not.toBe(added.name);
  });

  it('leaves a name or description the user wrote alone', async () => {
    const renamed = app({ starterId: 'pomodoro-timer', name: 'My focus timer', description: 'Mine' });
    const texts = await loadStarterTexts();
    expect(localizeStarterApps([renamed], starters, texts, tDe)[0]).toBe(renamed);
  });

  it('leaves apps that are not starters alone, and loads nothing when all match', () => {
    const own = app({ name: en['ideas.item.pomodoroTimer.title'] });
    expect(needsStarterTexts([own], starters, tDe)).toBe(false);
    const already = app({ starterId: 'pomodoro-timer', name: de['ideas.item.pomodoroTimer.title'] });
    expect(needsStarterTexts([already], starters, tDe)).toBe(false);
    expect(needsStarterTexts([added], starters, tDe)).toBe(true);
  });
});
