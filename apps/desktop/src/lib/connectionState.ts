/**
 * Connection posture, derived from live app state.
 *
 * This lived in `workspace/Titlebar.tsx` because V6 rendered it as a chip in
 * the top bar. V7 removed the chip but left the helper behind; V9 removes the
 * bar itself, so it moves here — its only consumers are `SettingsSheet` and
 * `PrivacyDataSection`, neither of which is chrome.
 */

export type ConnectionState = 'connected' | 'no-key' | 'local-only' | 'disconnected';

export function deriveConnectionState(opts: {
  boundaryOk: boolean;
  hasCredential: boolean;
  localOnly: boolean;
}): ConnectionState {
  if (!opts.boundaryOk) return 'disconnected';
  if (!opts.hasCredential) return 'no-key';
  if (opts.localOnly) return 'local-only';
  return 'connected';
}
