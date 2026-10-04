/// What a draft may use as sources, and whether its web search can run.

import type { AppSettings } from '@conduit/config-schema';
import type { DraftDetail, DraftSources } from '../ipc/contracts';

export const NO_DRAFT_SOURCES: DraftSources = { webSearch: false, researchRunIds: [] };

/** The draft's sources; a draft from before sources existed has none. */
export function draftSourcesOf(draft: Pick<DraftDetail, 'sources'> | null | undefined): DraftSources {
  return draft?.sources ?? NO_DRAFT_SOURCES;
}

/**
 * Why a draft's web search cannot run right now, as a catalog id, or null
 * when it can. The same gates as the chat's web search: on in Settings, its
 * notice accepted, and never in local-only mode.
 */
export function draftWebSearchUnavailableReasonId(
  settings: Pick<AppSettings, 'localOnly' | 'webSearchEnabled' | 'webSearchConsentAcknowledged'>,
): string | null {
  if (settings.localOnly) return 'writing.sources.web.unavailableLocalOnly';
  if (!settings.webSearchEnabled) return 'writing.sources.web.unavailableSearchOff';
  if (!settings.webSearchConsentAcknowledged) return 'writing.sources.web.unavailableNoConsent';
  return null;
}

/** The draft's turns offer the local web_search and web_fetch tools. */
export function draftWebSearchActive(
  draft: Pick<DraftDetail, 'sources'> | null | undefined,
  settings: Pick<AppSettings, 'localOnly' | 'webSearchEnabled' | 'webSearchConsentAcknowledged'>,
): boolean {
  return draftSourcesOf(draft).webSearch && draftWebSearchUnavailableReasonId(settings) === null;
}
