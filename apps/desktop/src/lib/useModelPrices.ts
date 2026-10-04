/**
 * Model prices for the renderer, resolved by the backend.
 *
 * One `resolve_model_prices` call per provider asked about, re-run when the set
 * of models changes or when `notifyModelPricesChanged()` fires (after the user
 * saves a price override, or a model listing brought in new provider prices).
 * Resolution is in-memory on the Rust side, so this is cheap and offline.
 */

import { useEffect, useMemo, useState } from 'react';
import type { ResolvedModelPrice } from '@conduit/config-schema';
import { resolveModelPrices } from '../ipc/client';

export interface PriceRequest {
  providerId: string;
  modelIds: string[];
}

/**
 * `undefined` while loading, `null` for an unpriced model, otherwise the price
 * and its source.
 */
export type PriceLookup = (providerId: string, modelId: string) => ResolvedModelPrice | null | undefined;

const listeners = new Set<() => void>();

/** Tell every mounted price consumer to ask again. */
export function notifyModelPricesChanged(): void {
  for (const listener of listeners) listener();
}

const keyOf = (providerId: string, modelId: string) => `${providerId}\u0000${modelId}`;

export function useModelPrices(requests: PriceRequest[]): PriceLookup {
  // A stable string identity for the request set, so a re-render that builds an
  // equal array does not refetch.
  const signature = useMemo(
    () =>
      JSON.stringify(
        requests
          .filter((r) => r.providerId && r.modelIds.length > 0)
          .map((r) => [r.providerId, [...new Set(r.modelIds)].sort()] as const)
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    [requests],
  );
  const [revision, setRevision] = useState(0);
  const [prices, setPrices] = useState<Map<string, ResolvedModelPrice | null>>(() => new Map());

  useEffect(() => {
    const bump = () => setRevision((n) => n + 1);
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);

  useEffect(() => {
    const wanted = JSON.parse(signature) as Array<[string, string[]]>;
    if (wanted.length === 0) return;
    let cancelled = false;
    void Promise.all(
      wanted.map(async ([providerId, modelIds]) => {
        try {
          const resolved = await resolveModelPrices(providerId, modelIds);
          return modelIds.map((modelId, i) => [keyOf(providerId, modelId), resolved[i] ?? null] as const);
        } catch {
          // A failed lookup reads as unpriced, never as free.
          return modelIds.map((modelId) => [keyOf(providerId, modelId), null] as const);
        }
      }),
    ).then((groups) => {
      if (cancelled) return;
      setPrices((previous) => {
        const next = new Map(previous);
        for (const group of groups) for (const [key, value] of group) next.set(key, value);
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [signature, revision]);

  return useMemo<PriceLookup>(
    () => (providerId, modelId) => {
      const key = keyOf(providerId, modelId);
      return prices.has(key) ? prices.get(key) : undefined;
    },
    [prices],
  );
}
