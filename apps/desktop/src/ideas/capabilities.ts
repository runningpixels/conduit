/// What the current setup can do, in one place (docs/plans/ideas-and-discovery.md).
///
/// Before this, "can this model make images / search / reach the internet"
/// was answered by predicates scattered through the chat code. This module
/// wraps the same rules — it does not invent new ones — so an idea is only
/// offered when clicking it will work.

import type { AppSettings, ProviderDescriptor } from '../ipc/contracts';
import { defaultImageModel } from '../chat/modelGeneratesImages';
import { artifactNetworkAvailable } from '../chat/artifactPrompt';
import type { Capability } from './catalog';

/// `ready` works now; `setup` can be made to work in Settings (or Documents);
/// `off` cannot here — local-only mode, or no provider that could.
export type CapabilityStatus = 'ready' | 'setup' | 'off';

/// Where the reader goes to set a capability up.
export type SetupTarget = 'privacy' | 'web-search' | 'providers' | 'workspace' | 'documents';

export const SETUP_TARGET: Record<Capability, SetupTarget> = {
  network: 'privacy',
  webSearch: 'web-search',
  imageGen: 'providers',
  documents: 'documents',
  workspace: 'workspace',
};

export interface CapabilityInput {
  settings: Pick<
    AppSettings,
    | 'localOnly'
    | 'activeProvider'
    | 'artifactNetworkEnabled'
    | 'webSearchEnabled'
    | 'workspaceToolsEnabled'
    | 'workspaceToolsConsentAcknowledged'
  >;
  /// The active provider's descriptor, when known.
  provider?: Pick<ProviderDescriptor, 'isLocal'> | null;
  /// Document collections that exist; `null` while unknown.
  collectionCount: number | null;
}

export interface Capabilities {
  status: Record<Capability, CapabilityStatus>;
  /// The active chat model runs on this computer — answers cost nothing.
  localModel: boolean;
}

export function resolveCapabilities({ settings, provider, collectionCount }: CapabilityInput): Capabilities {
  const localOnly = settings.localOnly;
  const status: Record<Capability, CapabilityStatus> = {
    network: artifactNetworkAvailable(settings) ? 'ready' : localOnly ? 'off' : 'setup',
    webSearch: localOnly ? 'off' : settings.webSearchEnabled ? 'ready' : 'setup',
    // The same gate the image tool uses: a provider with an image endpoint.
    imageGen: localOnly
      ? 'off'
      : defaultImageModel(settings.activeProvider) != null
        ? 'ready'
        : 'setup',
    // Local-only still allows a collection embedded by a local provider.
    documents: collectionCount != null && collectionCount > 0 ? 'ready' : 'setup',
    workspace:
      settings.workspaceToolsEnabled && settings.workspaceToolsConsentAcknowledged ? 'ready' : 'setup',
  };
  return { status, localModel: provider?.isLocal === true };
}

/// The capabilities that are ready, for noticing when one becomes ready.
export function readyCapabilities(caps: Capabilities): Capability[] {
  return (Object.keys(caps.status) as Capability[]).filter((c) => caps.status[c] === 'ready');
}
