/// Builds the `window.conduit` bridge handler for one page: `storage` (ADR-012)
/// wired straight to the four `page_storage_*` IPC calls, and `llm.complete`
/// (ADR-014) routed to a caller-supplied handler (`usePageLlm`'s `handler`),
/// since model access needs the hold/consent dance `useArtifactNetwork` and
/// `usePageLlm` already own — this hook has no opinion on consent, only
/// routing. `HtmlArtifactRenderer`'s `bridge` prop. The view that renders the
/// page supplies the principal (`artifact:<id>` or `app:<id>`) — the hook
/// never guesses it, and returns `undefined` when there is none, matching
/// `useArtifactNetwork`'s null-page convention.

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

/** `usePageLlm(principal).handler` — takes the already-validated `llm.complete`
 *  params and resolves the same outcome shape every bridge method does. */
export type PageLlmBridgeHandler = (params: unknown) => Promise<PageBridgeOutcome>;

export function usePageBridge(principal: PagePrincipal | null, llm?: PageLlmBridgeHandler): PageBridgeHandler | undefined {
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
          case 'llm.complete': {
            if (!llm) return { ok: false, error: { code: 'unavailable', message: 'This page has no model access.' } };
            return await llm(params);
          }
          default:
            return { ok: false, error: { code: 'unavailable', message: 'This page has no storage.' } };
        }
      } catch (e) {
        return { ok: false, error: bridgeErrorFromIpc(e) };
      }
    };
  }, [principal, llm]);
}
