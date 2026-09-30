/// Builds the `window.conduit.storage` handler for one page (ADR-012):
/// `HtmlArtifactRenderer`'s `bridge` prop, wired to the six `page_storage_*`
/// IPC calls. The view that renders the page supplies the principal
/// (`artifact:<id>` or `app:<id>`) — the hook never guesses it, and returns
/// `undefined` when there is none, matching `useArtifactNetwork`'s null-page
/// convention.

import { useMemo } from 'react';
import {
  bridgeErrorFromIpc,
  pageStorageDelete,
  pageStorageGet,
  pageStorageKeys,
  pageStorageSet,
  type PagePrincipal,
} from '../ipc/client';
import type { PageBridgeHandler, PageBridgeOutcome } from '../artifacts/pageBridge';

export function usePageBridge(principal: PagePrincipal | null): PageBridgeHandler | undefined {
  return useMemo<PageBridgeHandler | undefined>(() => {
    if (!principal) return undefined;
    return async (method, params): Promise<PageBridgeOutcome> => {
      try {
        switch (method) {
          case 'storage.get': {
            const { key } = params as { key: string };
            return { ok: true, result: await pageStorageGet(principal, key) };
          }
          case 'storage.set': {
            const { key, value } = params as { key: string; value: unknown };
            await pageStorageSet(principal, key, value);
            return { ok: true, result: null };
          }
          case 'storage.delete': {
            const { key } = params as { key: string };
            await pageStorageDelete(principal, key);
            return { ok: true, result: null };
          }
          case 'storage.keys': {
            const { prefix } = params as { prefix?: string };
            return { ok: true, result: await pageStorageKeys(principal, prefix) };
          }
          default:
            return { ok: false, error: { code: 'unavailable', message: 'This page has no storage.' } };
        }
      } catch (e) {
        return { ok: false, error: bridgeErrorFromIpc(e) };
      }
    };
  }, [principal]);
}
