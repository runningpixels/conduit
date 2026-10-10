import type { AppSettings } from '@conduit/config-schema';

/**
 * Why the composer's Web toggle cannot turn on right now, as a catalog id, or
 * null when it can. The same gate the "+" menu's web search item used to hide
 * itself behind (`webSearchEnabled && !localOnly`), with a reason, because the
 * toggle is always in the bar.
 */
export function webSearchUnavailableReasonId(
  settings: Pick<AppSettings, 'localOnly' | 'webSearchEnabled'>,
): string | null {
  if (settings.localOnly) return 'chat.composer.webSearch.unavailableLocalOnly';
  if (!settings.webSearchEnabled) return 'chat.composer.webSearch.unavailableSearchOff';
  return null;
}

/**
 * Why Research cannot start right now, as a catalog id, or null when it can.
 *
 * Research reads whole pages through the local search backend, so it needs web
 * search on and its notice accepted, and it is never available in local-only
 * mode. Rust refuses a start for the same reasons (`start_research`); this is
 * the same rule, checked early so the composer's toggle can say why it is disabled.
 */
export function researchUnavailableReasonId(
  settings: Pick<AppSettings, 'localOnly' | 'webSearchEnabled' | 'webSearchConsentAcknowledged'>,
): string | null {
  if (settings.localOnly) return 'chat.composer.research.unavailableLocalOnly';
  if (!settings.webSearchEnabled) return 'chat.composer.research.unavailableSearchOff';
  if (!settings.webSearchConsentAcknowledged) return 'chat.composer.research.unavailableNoConsent';
  return null;
}
