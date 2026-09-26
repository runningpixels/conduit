/// The document panel's side of the artifact fetch bridge (ADR-010).
///
/// A page's request to a site it may reach goes straight to Rust. A request
/// to a site not yet decided is *held*: the panel shows a banner, the reader
/// opens the consent dialog, and the decision releases or refuses every held
/// request to that site. This hook decides only whether to ask — Rust checks
/// the grant, the address and every cap again on each request.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  artifactFetch,
  getArtifactNetworkState,
  grantArtifactNetwork,
  revokeArtifactNetworkGrant,
  type ArtifactNetworkState,
} from '../ipc/client';
import {
  isLocalNetworkOrigin,
  requestOrigin,
  type ArtifactFetchMessage,
  type ArtifactFetchResult,
  type ArtifactNetworkHandler,
} from '../artifacts/networkBridge';

export type NetworkDecision = 'deny' | 'session' | 'page';

export interface NetworkLogEntry {
  id: number;
  at: number;
  origin: string;
  method: string;
  url: string;
  status?: number;
  bytes?: number;
  ms?: number;
  error?: string;
  /// Made after the page changed since its sites were allowed (or since its
  /// first request, for a site allowed in an earlier session).
  sinceChange: boolean;
}

/// A site the page asked for that the reader has not decided on yet.
export interface PendingSite {
  origin: string;
  first: { method: string; url: string; body: ArrayBuffer | null; contentType?: string };
}

interface Held {
  message: ArtifactFetchMessage;
  resolve: (result: ArtifactFetchResult) => void;
}

// Session memory, per artifact, surviving the panel re-rendering the page:
// refusals ("Don't allow" / "Not now") and the request log.
const deniedByArtifact = new Map<string, Set<string>>();
const logByArtifact = new Map<string, NetworkLogEntry[]>();
// The page's content when the reader last allowed a site for it, or when it
// first made a request: later requests from different content are marked.
const baselineByArtifact = new Map<string, string>();
let logSeq = 0;
const LOG_LIMIT = 200;

function bytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ArtifactNetwork {
  handler: ArtifactNetworkHandler;
  state: ArtifactNetworkState | null;
  denied: ReadonlySet<string>;
  pending: PendingSite[];
  log: NetworkLogEntry[];
  decide: (origins: string[], decision: NetworkDecision) => Promise<void>;
  revoke: (origin: string) => Promise<void>;
}

/**
 * @param artifactId the saved page, or null when none is shown
 * @param contentHash changes whenever the page's content does; requests made
 *   after a change are marked in the log
 * @param policyKey changes when a setting that can block every request does
 *   (local-only, the Settings switch), so the state is read again
 */
export function useArtifactNetwork(
  artifactId: string | null,
  contentHash: string,
  policyKey = '',
): ArtifactNetwork {
  const [state, setState] = useState<ArtifactNetworkState | null>(null);
  const [pending, setPending] = useState<PendingSite[]>([]);
  const [log, setLog] = useState<NetworkLogEntry[]>([]);
  const [deniedVersion, setDeniedVersion] = useState(0);
  const held = useRef(new Map<string, Held[]>());
  const stateRef = useRef<ArtifactNetworkState | null>(null);
  const contentRef = useRef(contentHash);
  contentRef.current = contentHash;
  const idRef = useRef(artifactId);
  idRef.current = artifactId;

  const refresh = useCallback(async () => {
    if (!artifactId) return;
    try {
      const next = await getArtifactNetworkState(artifactId);
      if (idRef.current !== artifactId) return;
      stateRef.current = next;
      setState(next);
    } catch {
      /* the panel still works; requests will fail in Rust if not allowed */
    }
  }, [artifactId]);

  // A different page: forget the held requests of the last one and load this
  // one's grants and log.
  useEffect(() => {
    for (const queue of held.current.values()) {
      for (const h of queue) h.resolve({ ok: false, error: 'The page was closed.' });
    }
    held.current.clear();
    setPending([]);
    stateRef.current = null;
    setState(null);
    setLog(artifactId ? [...(logByArtifact.get(artifactId) ?? [])] : []);
    void refresh();
  }, [artifactId, refresh]);

  const firstPolicy = useRef(true);
  useEffect(() => {
    if (firstPolicy.current) {
      firstPolicy.current = false;
      return;
    }
    stateRef.current = null;
    void refresh();
  }, [policyKey, refresh]);

  const appendLog = useCallback(
    (entry: NetworkLogEntry) => {
      if (!artifactId) return;
      const list = logByArtifact.get(artifactId) ?? [];
      const at = list.findIndex((e) => e.id === entry.id);
      if (at >= 0) list[at] = entry;
      else list.push(entry);
      if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
      logByArtifact.set(artifactId, list);
      if (idRef.current === artifactId) setLog([...list]);
    },
    [artifactId],
  );

  const execute = useCallback(
    async (message: ArtifactFetchMessage, origin: string): Promise<ArtifactFetchResult> => {
      if (!artifactId) return { ok: false, error: 'This page is not saved.' };
      const started = Date.now();
      const content = contentRef.current;
      if (!baselineByArtifact.has(artifactId)) baselineByArtifact.set(artifactId, content);
      const entry: NetworkLogEntry = {
        id: ++logSeq,
        at: started,
        origin,
        method: message.method,
        url: message.url,
        sinceChange: baselineByArtifact.get(artifactId) !== content,
      };
      appendLog(entry);
      try {
        const response = await artifactFetch({
          artifactId,
          url: message.url,
          method: message.method,
          headers: message.headers,
          body: message.body ? bytesToBase64(message.body) : undefined,
        });
        const body = base64ToBytes(response.body);
        appendLog({ ...entry, status: response.status, bytes: body.byteLength, ms: Date.now() - started });
        return {
          ok: true,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          url: response.url,
          body,
        };
      } catch (error) {
        const text = errorText(error);
        appendLog({ ...entry, error: text, ms: Date.now() - started });
        return { ok: false, error: text };
      }
    },
    [artifactId, appendLog],
  );

  const denied = useMemo(
    () => (artifactId ? deniedByArtifact.get(artifactId) ?? new Set<string>() : new Set<string>()),
    // deniedVersion bumps when the set changes in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [artifactId, deniedVersion],
  );

  const handler = useMemo<ArtifactNetworkHandler>(
    () => ({
      request: async (message) => {
        const origin = requestOrigin(message.url);
        if (!origin) {
          return { ok: false, error: 'Only https addresses can be contacted.' };
        }
        if (isLocalNetworkOrigin(origin)) {
          return { ok: false, error: 'Pages cannot contact your computer or local network.' };
        }
        const current = stateRef.current ?? (artifactId ? await getArtifactNetworkState(artifactId).catch(() => null) : null);
        if (current && !stateRef.current) {
          stateRef.current = current;
          setState(current);
        }
        if (current?.blockedReason) return { ok: false, error: current.blockedReason };
        if (artifactId && deniedByArtifact.get(artifactId)?.has(origin)) {
          return { ok: false, error: `You didn't allow this page to contact ${new URL(origin).host}.` };
        }
        if (current && (current.always.includes(origin) || current.session.includes(origin))) {
          return execute(message, origin);
        }
        return new Promise<ArtifactFetchResult>((resolve) => {
          const queue = held.current.get(origin) ?? [];
          queue.push({ message, resolve });
          held.current.set(origin, queue);
          if (queue.length === 1) {
            const contentType = message.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1];
            setPending((list) =>
              list.some((p) => p.origin === origin)
                ? list
                : [...list, { origin, first: { method: message.method, url: message.url, body: message.body, contentType } }],
            );
          }
        });
      },
    }),
    [artifactId, execute],
  );

  const decide = useCallback(
    async (origins: string[], decision: NetworkDecision) => {
      if (!artifactId) return;
      for (const origin of origins) {
        const queue = held.current.get(origin) ?? [];
        held.current.delete(origin);
        if (decision === 'deny') {
          const set = deniedByArtifact.get(artifactId) ?? new Set<string>();
          set.add(origin);
          deniedByArtifact.set(artifactId, set);
          const host = new URL(origin).host;
          for (const h of queue) h.resolve({ ok: false, error: `You didn't allow this page to contact ${host}.` });
          continue;
        }
        try {
          await grantArtifactNetwork(artifactId, origin, decision);
        } catch (error) {
          for (const h of queue) h.resolve({ ok: false, error: errorText(error) });
          continue;
        }
        deniedByArtifact.get(artifactId)?.delete(origin);
        baselineByArtifact.set(artifactId, contentRef.current);
        const base = stateRef.current ?? { blockedReason: null, always: [], session: [] };
        const next: ArtifactNetworkState =
          decision === 'page'
            ? { ...base, always: [...new Set([...base.always, origin])] }
            : { ...base, session: [...new Set([...base.session, origin])] };
        stateRef.current = next;
        setState(next);
        for (const h of queue) void execute(h.message, origin).then(h.resolve);
      }
      setDeniedVersion((v) => v + 1);
      setPending((list) => list.filter((p) => !origins.includes(p.origin)));
    },
    [artifactId, execute],
  );

  const revoke = useCallback(
    async (origin: string) => {
      if (!artifactId) return;
      await revokeArtifactNetworkGrant(artifactId, origin);
      await refresh();
    },
    [artifactId, refresh],
  );

  return { handler, state, denied, pending, log, decide, revoke };
}
