/// Settings-derived props every app host passes to `AppView`, shared by the main
/// window (`App`) and an app's own window (`StandaloneAppRoot`).

import type { AppSettings } from '@conduit/config-schema';

/** Changes when local-only or the artifact-network settings change, so an open
 *  app reloads under the new policy. */
export function appNetworkPolicyKey(
  settings: Pick<AppSettings, 'localOnly' | 'artifactNetworkEnabled' | 'artifactFullWebAccess'>,
): string {
  return `${settings.localOnly}:${settings.artifactNetworkEnabled}:${settings.artifactFullWebAccess === true}`;
}
