import type { AppSummary, StarterAppInfo } from '../ipc/contracts';
import { loadMessages, TRANSLATED_LOCALE_CODES, type Translate } from '../i18n';

/**
 * A starter app is saved under its Ideas title and blurb in the language the
 * user had when they added it, and from then on it is an ordinary app with a
 * stored name. Switch languages and "Pomodoro timer" stayed English. These
 * helpers show a starter's name and description in the current language for
 * as long as they are still the ones it was added with in *some* language —
 * a name the user typed is theirs and is left alone.
 */

/** Every language's title and blurb for each Ideas entry a starter uses. */
export type StarterTexts = Map<string, { titles: Set<string>; blurbs: Set<string> }>;

let cached: Promise<StarterTexts> | null = null;

/** Read each catalog once for the starters' Ideas strings. Only called when a
 *  starter app's name is not the current language's, so a user who never
 *  changes language never loads the other catalogs. */
export function loadStarterTexts(): Promise<StarterTexts> {
  cached ??= Promise.all(TRANSLATED_LOCALE_CODES.map((code) => loadMessages(code).catch(() => ({})))).then(
    (catalogs) => {
      const texts: StarterTexts = new Map();
      const match = /^ideas\.item\.(.+)\.(title|blurb)$/;
      for (const catalog of catalogs) {
        for (const [key, value] of Object.entries(catalog)) {
          const m = match.exec(key);
          if (!m) continue;
          const entry = texts.get(m[1]) ?? { titles: new Set<string>(), blurbs: new Set<string>() };
          (m[2] === 'title' ? entry.titles : entry.blurbs).add(value);
          texts.set(m[1], entry);
        }
      }
      return texts;
    },
  );
  return cached;
}

/** The Ideas entry an installed starter came from, if it is one. */
function ideaOf(app: AppSummary, starters: readonly StarterAppInfo[]): string | undefined {
  if (!app.starterId) return undefined;
  return starters.find((s) => s.id === app.starterId)?.ideaId;
}

/** True when some starter app's name differs from its current-language title,
 *  i.e. the other catalogs are worth loading. */
export function needsStarterTexts(apps: readonly AppSummary[], starters: readonly StarterAppInfo[], t: Translate): boolean {
  return apps.some((app) => {
    const idea = ideaOf(app, starters);
    return idea !== undefined && app.name !== t(`ideas.item.${idea}.title`);
  });
}

/** `apps` with each untouched starter's name and description in the current language. */
export function localizeStarterApps(
  apps: AppSummary[],
  starters: readonly StarterAppInfo[],
  texts: StarterTexts,
  t: Translate,
): AppSummary[] {
  return apps.map((app) => {
    const idea = ideaOf(app, starters);
    const known = idea !== undefined ? texts.get(idea) : undefined;
    if (!idea || !known) return app;
    const name = known.titles.has(app.name) ? t(`ideas.item.${idea}.title`) : app.name;
    const description =
      app.description && known.blurbs.has(app.description) ? t(`ideas.item.${idea}.blurb`) : app.description;
    return name === app.name && description === app.description ? app : { ...app, name, description };
  });
}

/** Load the texts when needed and localize; `apps` unchanged otherwise. */
export async function withLocalStarterNames(
  apps: AppSummary[],
  starters: readonly StarterAppInfo[],
  t: Translate,
): Promise<AppSummary[]> {
  if (!needsStarterTexts(apps, starters, t)) return apps;
  try {
    return localizeStarterApps(apps, starters, await loadStarterTexts(), t);
  } catch {
    return apps;
  }
}
