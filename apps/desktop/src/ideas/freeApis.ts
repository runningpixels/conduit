/// Free public APIs that small pages can build on: https, no key, no sign-up.
/// Each one is used by at least one idea (`Idea.apis`), and the Ideas page
/// lists them under "Free APIs" with a Try button for that idea.
///
/// The data lives in `freeApis.json` so `scripts/check-free-apis.mjs` can read
/// the same list with plain Node — no TypeScript loader, no build step — and
/// GET every `example` weekly (.github/workflows/free-apis.yml). This module
/// types it; `freeApis.test.ts` checks the shape and the links to ideas.
///
/// `hosts` is every host a page using the API must reach, image hosts
/// included, written the way a page declares them in
/// `<meta name="conduit-network">` (bare host names; artifacts/networkHosts.ts).
/// Pages load images by fetch() through the same proxy, which follows only
/// same-site redirects — so an image host that redirects elsewhere (Open
/// Library covers → archive.org) or sits behind a bot challenge (the Art
/// Institute's IIIF server) is left out, and its idea does without images.
///
/// `verified.on` is the last day the example URL answered 200 JSON without a
/// key through a checker that behaves like the artifact proxy.

import data from './freeApis.json';

export interface FreeApiLimits {
  /// At most this many requests…
  requests: number;
  /// …per this many seconds (1 second, 60 minute, 3600 hour, 86400 day).
  perSeconds: number;
}

export interface FreeApi {
  id: string;
  /// The service's own name; never translated.
  name: string;
  homepage: string;
  docs: string;
  /// Bare host names, as a page declares them.
  hosts: readonly string[];
  /// A request that answers JSON without a key.
  example: string;
  /// The published or conservative limit for anonymous use; absent → see the docs.
  limits?: FreeApiLimits;
  /// Credit or terms a page should honour, as the service words it.
  attribution?: string;
  verified: { on: string };
}

export const FREE_APIS: readonly FreeApi[] = data as readonly FreeApi[];

export function freeApiById(id: string): FreeApi | undefined {
  return FREE_APIS.find((api) => api.id === id);
}

/// "Open-Meteo, Open-Meteo Geocoding · no key" for an idea's card, or null
/// for an idea that uses no free API.
export function ideaApiLabel(
  idea: { apis?: readonly string[] },
  t: (id: string, values?: Record<string, string>) => string,
): string | null {
  const names = (idea.apis ?? []).map((id) => freeApiById(id)?.name).filter((n): n is string => n != null);
  return names.length > 0 ? t('ideas.api.label', { names: names.join(', ') }) : null;
}

/// The i18n key for what the API gives, in a few words.
export function freeApiGivesKey(api: Pick<FreeApi, 'id'>): string {
  return `ideas.api.${api.id}.gives`;
}

/// The i18n key and values for an API's limit line.
export function freeApiLimitMessage(api: Pick<FreeApi, 'limits'>): {
  key: string;
  values?: Record<string, number>;
} {
  const limits = api.limits;
  if (!limits) return { key: 'ideas.api.limit.seeDocs' };
  const unit = ({ 1: 'second', 60: 'minute', 3600: 'hour', 86400: 'day' } as Record<number, string>)[limits.perSeconds];
  if (unit) return { key: `ideas.api.limit.${unit}`, values: { count: limits.requests } };
  return { key: 'ideas.api.limit.seconds', values: { count: limits.requests, seconds: limits.perSeconds } };
}
