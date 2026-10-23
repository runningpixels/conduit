/// A small chip naming the provider a model runs on ("OpenRouter"), for agent
/// nodes in chat and in a run's agent tree.

import { useEffect, useState } from 'react';
import { listProviderDescriptors } from '../ipc/client';

/// Splits a "provider/model" string at the first slash. A bare name has no provider.
export function splitModel(model: string | null | undefined): { providerId: string; modelId: string } {
  const text = (model ?? '').trim();
  const at = text.indexOf('/');
  return at < 0
    ? { providerId: '', modelId: text }
    : { providerId: text.slice(0, at), modelId: text.slice(at + 1) };
}

let namesPromise: Promise<Map<string, string>> | null = null;

/// Display names by provider id, read once per session.
function providerNames(): Promise<Map<string, string>> {
  if (!namesPromise) {
    namesPromise = Promise.resolve()
      .then(() => listProviderDescriptors())
      .then((list) => new Map((Array.isArray(list) ? list : []).map((p) => [p.id, p.displayName] as const)))
      .catch(() => {
        // Try again next time; the id is a fine label meanwhile.
        namesPromise = null;
        return new Map<string, string>();
      });
  }
  return namesPromise;
}

/// The provider's display name; its id until the names have loaded.
export function useProviderName(providerId: string): string {
  const [names, setNames] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    void providerNames().then((map) => {
      if (!cancelled) setNames(map);
    });
    return () => {
      cancelled = true;
    };
  }, [providerId]);
  return names?.get(providerId) ?? providerId;
}

export function ProviderBadge({ model }: { model: string | null | undefined }) {
  const { providerId } = splitModel(model);
  const label = useProviderName(providerId);
  if (!providerId) return null;
  return (
    <span className="provider-badge" title={model ?? undefined}>
      {label}
    </span>
  );
}
