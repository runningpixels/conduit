/// The fetch bridge for HTML artifacts (ADR-010).
///
/// The frame keeps `connect-src 'none'` — it has no network of its own. This
/// Conduit-owned script, injected next to the link interceptor, replaces
/// `window.fetch` with a message to the host window. The host asks the user
/// (per page, per site), has Rust make the request, and posts the answer back;
/// the script turns it into an ordinary `Response`. A refused or failed request
/// rejects the way a network error would, so the page's own error handling
/// runs. `XMLHttpRequest`, `WebSocket` and `EventSource` stay blocked by the
/// unchanged CSP — unless the reader gave the page full web access (ADR-007),
/// whose CSP lets them reach https/wss directly; `fetch()` still comes here,
/// so it keeps the proxy's checks and no CORS. WebRTC isn't governed by CSP at all; it is closed at the
/// WebView level (`webview_args.rs`) and removed in the frame (`webrtcBlock.ts`).
///
/// Only the finished preview gets this script; the live preview of a document
/// still being written has no network.

export const ARTIFACT_FETCH_MESSAGE_TYPE = 'conduit:artifact-fetch';
export const ARTIFACT_FETCH_RESULT_MESSAGE_TYPE = 'conduit:artifact-fetch-result';
export const ARTIFACT_FETCH_ABORT_MESSAGE_TYPE = 'conduit:artifact-fetch-abort';

/// A request as the frame describes it. Untrusted: the page can post anything,
/// so the host validates it and Rust checks it again.
export interface ArtifactFetchMessage {
  id: number;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: ArrayBuffer | null;
}

/// What the host answers: a response, or why there is none.
export type ArtifactFetchResult =
  | {
      ok: true;
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
      url: string;
      body: ArrayBuffer;
    }
  | { ok: false; error: string };

/// The abort reason the host gives when the frame itself went away (unmounted
/// or replaced by another document) — as opposed to the page giving up on a
/// request, e.g. its own timeout firing while the reader was still deciding.
export const ARTIFACT_FRAME_CLOSED = 'conduit:artifact-frame-closed';

/// Handles a page's requests; provided by the document panel for a saved page.
/// `signal` aborts when the page gives up on the request (its fetch was
/// aborted) or the frame goes away (reason `ARTIFACT_FRAME_CLOSED`); the host
/// posts no answer for an aborted request.
export interface ArtifactNetworkHandler {
  request(message: ArtifactFetchMessage, signal?: AbortSignal): Promise<ArtifactFetchResult>;
}

export const ARTIFACT_NETWORK_BRIDGE_SCRIPT =
  `(function(){var REQ='${ARTIFACT_FETCH_MESSAGE_TYPE}',RES='${ARTIFACT_FETCH_RESULT_MESSAGE_TYPE}',ABORT='${ARTIFACT_FETCH_ABORT_MESSAGE_TYPE}';` +
  `var seq=0,pending={};` +
  `function abortError(){try{return new DOMException('The operation was aborted.','AbortError');}catch(_){var e=new Error('The operation was aborted.');e.name='AbortError';return e;}}` +
  `window.addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;if(!d||d.type!==RES)return;` +
  `var p=pending[d.id];if(!p)return;delete pending[d.id];` +
  `if(d.error){p.reject(new TypeError('Failed to fetch: '+d.error));return;}` +
  `var nullBody=p.method==='HEAD'||d.status===204||d.status===205||d.status===304;` +
  `var status=(d.status>=200&&d.status<=599)?d.status:502;` +
  `try{var res=new Response(nullBody?null:d.body,{status:status,statusText:d.statusText||'',headers:d.headers||[]});` +
  `try{Object.defineProperty(res,'url',{value:d.url});}catch(_){}p.resolve(res);}catch(err){p.reject(err);}});` +
  `window.fetch=function(input,init){return new Promise(function(resolve,reject){var req;` +
  `try{req=new Request(input,init);}catch(err){reject(err);return;}` +
  `if(!/^https?:/i.test(req.url)){reject(new TypeError('Failed to fetch: only web addresses can be requested'));return;}` +
  `if(req.signal&&req.signal.aborted){reject(abortError());return;}` +
  `var id=++seq,method=req.method,headers=[];req.headers.forEach(function(v,k){headers.push([k,v]);});` +
  `var bodyP=(method==='GET'||method==='HEAD')?Promise.resolve(null):req.arrayBuffer();` +
  `bodyP.then(function(body){pending[id]={resolve:resolve,reject:reject,method:method};` +
  `if(req.signal){req.signal.addEventListener('abort',function(){if(!pending[id])return;delete pending[id];parent.postMessage({type:ABORT,id:id},'*');reject(abortError());});}` +
  `parent.postMessage({type:REQ,id:id,url:req.url,method:method,headers:headers,body:body},'*',body?[body]:[]);},reject);});};` +
  `})();`;

/// Parse a request message from the frame; `null` unless it is well formed.
export function parseArtifactFetchMessage(data: unknown): ArtifactFetchMessage | null {
  if (data == null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== ARTIFACT_FETCH_MESSAGE_TYPE) return null;
  if (typeof d.id !== 'number' || !Number.isFinite(d.id)) return null;
  if (typeof d.url !== 'string' || d.url.length > 8192) return null;
  if (typeof d.method !== 'string' || d.method.length > 16) return null;
  if (!Array.isArray(d.headers)) return null;
  const headers: Array<[string, string]> = [];
  for (const pair of d.headers.slice(0, 64)) {
    if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
      headers.push([pair[0], pair[1]]);
    }
  }
  const body = d.body instanceof ArrayBuffer ? d.body : null;
  return { id: d.id, url: d.url, method: d.method.toUpperCase(), headers, body };
}

/// The id of a request the page gave up on; `null` unless it is such a message.
export function parseArtifactFetchAbortMessage(data: unknown): number | null {
  if (data == null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  return d.type === ARTIFACT_FETCH_ABORT_MESSAGE_TYPE && typeof d.id === 'number' ? d.id : null;
}

/// The origin a grant is keyed on, as Rust computes it: `https://host[:port]`,
/// lowercase, default port elided. `null` for anything that is not https.
export function requestOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/// True for hosts that are never public: `localhost`, `*.local`, and IP
/// literals in loopback, private, link-local or CGNAT ranges. The host refuses
/// these without asking the reader; Rust refuses them (and anything that
/// *resolves* to such an address) regardless.
export function isLocalNetworkOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return v6 === '::1' || v6 === '::' || /^(fc|fd|fe[89ab])/.test(v6) || v6.startsWith('::ffff:');
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}
