import type { AppSettings } from '@conduit/config-schema';

/**
 * Why Research cannot start right now, as a catalog id, or null when it can.
 *
 * Research reads whole pages through the local search backend, so it needs web
 * search on and its notice accepted, and it is never available in local-only
 * mode. Rust refuses a start for the same reasons (`start_research`); this is
 * the same rule, checked early so the menu item can say why it is disabled.
 */
export function researchUnavailableReasonId(
  settings: Pick<AppSettings, 'localOnly' | 'webSearchEnabled' | 'webSearchConsentAcknowledged'>,
): string | null {
  if (settings.localOnly) return 'chat.composer.research.unavailableLocalOnly';
  if (!settings.webSearchEnabled) return 'chat.composer.research.unavailableSearchOff';
  if (!settings.webSearchConsentAcknowledged) return 'chat.composer.research.unavailableNoConsent';
  return null;
}
