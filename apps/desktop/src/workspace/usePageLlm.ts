/// The document panel's / app view's side of page model access (ADR-014).
///
/// A page's `window.conduit.llm.complete()` call goes straight to Rust once
/// the reader has allowed it. The first call from a page that hasn't been
/// decided on yet is *held*: the panel shows a banner, the reader opens the
/// consent dialog, and the decision releases or refuses every held call. This
/// hook decides only whether to ask — Rust re-checks the grant, the limits
/// and the active provider on every call. Modeled on `useArtifactNetwork`'s
/// hold pattern, simplified: there is one thing to grant per page (not one
/// per site), and the call carries no data worth previewing in the dialog
/// (just a provider name and a local/cloud note).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  grantPageLlm,
  pageLlmComplete,
  pageLlmState,
  revokePageLlm,
  type PageLlmCompleteRequest,
  type PagePrincipal,
  type PageLlmState,
} from '../ipc/client';
import { bridgeErrorFromIpc } from '../ipc/client';
import type { PageBridgeOutcome } from '../artifacts/pageBridge';

export type PageLlmDecision = 'deny' | 'session' | 'page';

interface HeldCall {
  request: PageLlmCompleteRequest;
  resolve: (outcome: PageBridgeOutcome) => void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `null` unless `params` is a well-formed `llm.complete` request — the
 *  bridge already validated this shape before the handler ever sees it
 *  (`parsePageBridgeRequest`), so this is a defensive narrowing, not a second
 *  validation pass. */
function asLlmRequest(params: unknown): PageLlmCompleteRequest | null {
  if (params == null || typeof params !== 'object') return null;
  const p = params as Record<string, unknown>;
  if (typeof p.prompt !== 'string' || p.prompt.length === 0) return null;
  const request: PageLlmCompleteRequest = { prompt: p.prompt };
  if (typeof p.system === 'string') request.system = p.system;
  if (typeof p.maxTokens === 'number') request.maxTokens = p.maxTokens;
  if (typeof p.json === 'boolean') request.json = p.json;
  return request;
}

export interface UsePageLlm {
  state: PageLlmState | null;
  /** A call is waiting on the reader's decision. */
  pending: boolean;
  /** Wired to `usePageBridge`'s `llm` handler. */
  handler: (params: unknown) => Promise<PageBridgeOutcome>;
  decide: (decision: PageLlmDecision) => Promise<void>;
  /** "Stop model access" (AppView's ⋯ menu): clears both the session and any
   *  stored grant, and re-reads the state. */
  revoke: () => Promise<void>;
}

export function usePageLlm(principal: PagePrincipal | null): UsePageLlm {
  const [state, setState] = useState<PageLlmState | null>(null);
  const [pending, setPending] = useState(false);
  const stateRef = useRef<PageLlmState | null>(null);
  const heldRef = useRef<HeldCall[]>([]);
  // Remembered only for this page's current load — a fresh mount (a
  // different artifact/app, or this one reopened) may ask again.
  const deniedRef = useRef(false);
  const idRef = useRef(principal);
  idRef.current = principal;

  const refresh = useCallback(async (): Promise<PageLlmState | null> => {
    if (!principal) return null;
    try {
      const next = await pageLlmState(principal);
      if (idRef.current !== principal) return next;
      stateRef.current = next;
      setState(next);
      return next;
    } catch {
      return null;
    }
  }, [principal]);

  // A different page (or none): forget held calls and this page's denial,
  // and load the new one's state.
  useEffect(() => {
    for (const h of heldRef.current) {
      h.resolve({ ok: false, error: { code: 'not_granted', message: 'The page was closed.' } });
    }
    heldRef.current = [];
    setPending(false);
    deniedRef.current = false;
    stateRef.current = null;
    setState(null);
    void refresh();
  }, [principal, refresh]);

  const runComplete = useCallback(
    async (request: PageLlmCompleteRequest): Promise<PageBridgeOutcome> => {
      if (!principal) return { ok: false, error: { code: 'unavailable', message: 'This page has no model access.' } };
      try {
        const result = await pageLlmComplete(principal, request);
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: bridgeErrorFromIpc(e) };
      }
    },
    [principal],
  );

  const hold = useCallback((request: PageLlmCompleteRequest): Promise<PageBridgeOutcome> => {
    return new Promise((resolve) => {
      heldRef.current.push({ request, resolve });
      setPending(true);
    });
  }, []);

  const handler = useCallback(
    async (params: unknown): Promise<PageBridgeOutcome> => {
      if (!principal) return { ok: false, error: { code: 'unavailable', message: 'This page has no model access.' } };
      const request = asLlmRequest(params);
      if (!request) return { ok: false, error: { code: 'invalid', message: 'prompt must be a non-empty string.' } };
      const current = stateRef.current ?? (await refresh());
      if (!current) return { ok: false, error: { code: 'unavailable', message: 'The model is unavailable.' } };
      if (current.blockedReason) return { ok: false, error: { code: 'unavailable', message: current.blockedReason } };
      if (current.granted) return runComplete(request);
      if (deniedRef.current) {
        return { ok: false, error: { code: 'not_granted', message: "You didn't allow this page to use your model." } };
      }
      return hold(request);
    },
    [principal, refresh, runComplete, hold],
  );

  const decide = useCallback(
    async (decision: PageLlmDecision) => {
      if (!principal) return;
      const held = heldRef.current;
      heldRef.current = [];
      setPending(false);
      if (decision === 'deny') {
        deniedRef.current = true;
        for (const h of held) {
          h.resolve({ ok: false, error: { code: 'not_granted', message: "You didn't allow this page to use your model." } });
        }
        return;
      }
      try {
        await grantPageLlm(principal, decision);
      } catch (error) {
        const message = errorText(error);
        for (const h of held) h.resolve({ ok: false, error: { code: 'unavailable', message } });
        return;
      }
      deniedRef.current = false;
      await refresh();
      for (const h of held) void runComplete(h.request).then(h.resolve);
    },
    [principal, refresh, runComplete],
  );

  const revoke = useCallback(async () => {
    if (!principal) return;
    await revokePageLlm(principal);
    await refresh();
  }, [principal, refresh]);

  return { state, pending, handler, decide, revoke };
}
