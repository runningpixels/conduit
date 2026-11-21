/**
 * The model catalogue, shared by every model picker in the window and kept for
 * the session: a restart starts fresh, and Refresh in the menu fetches again.
 *
 * It used to live in each picker instance, so every new chat, every reply's
 * Retry ▾ and every remount fetched the whole catalogue again, and the menu
 * showed nothing until the slowest provider settled. A stopped local server
 * (Ollama, LM Studio) takes seconds to fail, so that was the menu's lag.
 *
 * Now each provider settles on its own and the menu draws it as it arrives.
 * A listing that worked is kept until Refresh or restart. One that failed or
 * came back empty is kept only briefly ({@link RETRY_FAILED_MS}), so a server
 * that was just started, or a key that was just saved, shows up on a later
 * open without a manual refresh.
 *
 * Only providers you can use are listed: a provider that needs a key is asked
 * for its models only once one is saved. Which providers have a key is checked
 * again on every open (a local keychain lookup), so a key saved in Settings
 * counts the next time the menu opens.
 */

import { useSyncExternalStore } from 'react';
import type { ModelInfo, ProviderDescriptor } from '../ipc/contracts';
import {
  listProviderDescriptors,
  listProviderModels,
  loadProviderCredentialReference,
} from '../ipc/client';

/** How long a single provider gets to answer before it counts as failed. A
 *  self-hosted endpoint behind a dropped route hangs until the OS gives up. */
export const MODEL_FETCH_TIMEOUT_MS = 2500;

/** How long a failed or empty listing is trusted before the next open tries again. */
export const RETRY_FAILED_MS = 60_000;

export type ProviderModels =
  | { state: 'loading' }
  | { state: 'ready'; models: ModelInfo[]; at: number };

export interface ModelCatalog {
  /** `null` until the provider list itself has loaded. */
  providers: ProviderDescriptor[] | null;
  models: Record<string, ProviderModels>;
  /** Provider id → whether a key is saved for it. */
  keys: Record<string, boolean>;
  /** True while a fetch the user asked for (Refresh) is running. */
  refreshing: boolean;
}

let catalog: ModelCatalog = { providers: null, models: {}, keys: {}, refreshing: false };
const listeners = new Set<() => void>();
let providersPromise: Promise<ProviderDescriptor[]> | null = null;
/** Bumped by a reset, so a fetch from before it cannot land afterwards. */
let generation = 0;

function update(next: Partial<ModelCatalog>) {
  catalog = { ...catalog, ...next };
  for (const listener of listeners) listener();
}

function setProviderModels(id: string, value: ProviderModels) {
  update({ models: { ...catalog.models, [id]: value } });
}

/** Resolves to `fallback` when `p` rejects or takes longer than `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }).catch(() => {
      clearTimeout(timer);
      resolve(fallback);
    });
  });
}

function needsFetch(entry: ProviderModels | undefined, now: number): boolean {
  if (!entry) return true;
  if (entry.state === 'loading') return false;
  return entry.models.length === 0 && now - entry.at > RETRY_FAILED_MS;
}

async function fetchProvider(id: string, gen: number): Promise<void> {
  setProviderModels(id, { state: 'loading' });
  const models = await withTimeout(listProviderModels(id), MODEL_FETCH_TIMEOUT_MS, [] as ModelInfo[]);
  if (gen !== generation) return;
  setProviderModels(id, { state: 'ready', models, at: Date.now() });
}

/**
 * Loads what is missing: the provider list once, then each provider that has
 * never listed, or whose failed listing is old enough to try again. Cheap to
 * call on every open: anything already cached is left alone.
 */
export async function ensureModelCatalog(currentProvider?: string): Promise<void> {
  const gen = generation;
  if (!providersPromise) {
    providersPromise = listProviderDescriptors().catch((error: unknown) => {
      providersPromise = null;
      throw error;
    });
  }
  let providers: ProviderDescriptor[];
  try {
    providers = await providersPromise;
  } catch {
    if (gen === generation) update({ providers: [] });
    return;
  }
  if (gen !== generation) return;
  if (catalog.providers !== providers) update({ providers });
  const keyed = await Promise.all(
    providers.map(async (p) => {
      if (p.credentialMode === 'none') return [p.id, false] as const;
      try {
        return [p.id, (await loadProviderCredentialReference(p.id)).storedInKeychain] as const;
      } catch {
        return [p.id, false] as const;
      }
    }),
  );
  if (gen !== generation) return;
  const keys = Object.fromEntries(keyed);
  update({ keys });
  const now = Date.now();
  await Promise.all(
    providers
      .filter((p) => p.credentialMode !== 'required' || keys[p.id] || p.id === currentProvider)
      .filter((p) => needsFetch(catalog.models[p.id], now))
      .map((p) => fetchProvider(p.id, gen)),
  );
}

/** Refresh: forget everything and list every provider again. */
export async function refreshModelCatalog(currentProvider?: string): Promise<void> {
  generation += 1;
  providersPromise = null;
  update({ models: {}, refreshing: true });
  try {
    await ensureModelCatalog(currentProvider);
  } finally {
    update({ refreshing: false });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether the menu shows this provider: one with a saved key, one that listed
 * models (a running local server), and always the one in use (so a
 * self-hosted endpoint with no model listing keeps its typing row). A
 * provider that needs a key you haven't given, or a local server that isn't
 * running, stays out of the menu. (A saved address doesn't count: Settings
 * stores LM Studio's default one whether or not it was ever used.)
 */
export function providerVisible(
  catalog: ModelCatalog,
  provider: ProviderDescriptor,
  currentProvider: string,
): boolean {
  if (provider.id === currentProvider) return true;
  if (catalog.keys[provider.id]) return true;
  const entry = catalog.models[provider.id];
  return entry?.state === 'ready' && entry.models.length > 0;
}

export function useModelCatalog(): ModelCatalog {
  return useSyncExternalStore(subscribe, () => catalog);
}

/** Tests only: back to an empty, never-loaded catalogue. */
export function resetModelCatalogForTests() {
  generation += 1;
  providersPromise = null;
  catalog = { providers: null, models: {}, keys: {}, refreshing: false };
}

// A test file shares one copy of this module across its tests, so the cache
// would carry from one test's mocks into the next. The vitest setup file calls
// this before each test. (Registered here rather than imported there: an
// import from the setup file would load the real IPC client ahead of each
// file's `vi.mock`. Dev and test builds only.)
if (import.meta.env.DEV) {
  (globalThis as { __resetModelCatalog?: () => void }).__resetModelCatalog = resetModelCatalogForTests;
}
