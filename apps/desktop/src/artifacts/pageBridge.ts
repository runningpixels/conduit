/// `window.conduit` — the page bridge (ADR-012). Storage is its first
/// namespace; later ones (model access, launch inputs) join the same
/// envelope without changing it.
///
/// The page never gets its own storage: every call is a message to the host,
/// which supplies the principal (`artifact:<id>` or `app:<id>`) and asks Rust,
/// which owns the limits. `window.conduit` lives in the page's own realm, so a
/// hostile page could reassign or wrap it — that only affects the page
/// itself; the boundary is Rust re-checking every call by principal.
///
/// Declared with `<meta name="conduit-capability" content="storage — why">`
/// (`declaredCapabilities` in `./networkHosts`); without it the bridge script
/// is never injected and `window.conduit` stays undefined.

export const PAGE_BRIDGE_MESSAGE_TYPE = 'conduit:bridge/v2';

/// Error codes Rust returns for a bridge call, from the `code:` prefix on its
/// `Err(String)` (see `ipc/client.ts`'s `bridgeErrorFromIpc`).
export type BridgeErrorCode = 'invalid' | 'quota' | 'unavailable' | 'rate_limited';

export type PageBridgeMethod = 'storage.get' | 'storage.set' | 'storage.delete' | 'storage.keys';

const PAGE_BRIDGE_METHODS: ReadonlySet<string> = new Set<PageBridgeMethod>([
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.keys',
]);

/// A validated request from the frame. Untrusted until parsed: the page can
/// post anything, so every field is checked before Rust ever sees it.
export type PageBridgeRequest =
  | { id: string; method: 'storage.get'; params: { key: string } }
  | { id: string; method: 'storage.set'; params: { key: string; value: unknown } }
  | { id: string; method: 'storage.delete'; params: { key: string } }
  | { id: string; method: 'storage.keys'; params: { prefix?: string } };

export type PageBridgeOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: BridgeErrorCode; message: string } };

/// Handles a page's bridge calls; provided by the view that rendered the page
/// (the document panel for an artifact, the app view for a saved app), which
/// alone knows the principal.
export type PageBridgeHandler = (
  method: PageBridgeMethod,
  params: unknown,
) => Promise<PageBridgeOutcome>;

/// The in-frame script: defines `window.conduit`, frozen, with a `storage`
/// namespace only when `'storage'` is among `capabilities`, and an `inputs`
/// getter only when `inputs` is non-null (ADR-013) — independent of
/// `capabilities`, since a page can declare launch inputs without declaring
/// any capability at all. Each storage call posts `{ type, id, method,
/// params }` to `parent` and resolves/rejects on the matching `{ type, id,
/// ok, result | error }` reply; replies from anywhere but `parent` are
/// ignored. `set` validates the value is JSON-serializable *in the page*
/// before posting anything — a value that isn't (a function, a circular
/// reference, a bigint) rejects with `invalid` locally, the same code Rust
/// would have used, without a round trip.
///
/// `inputs`, when given, seeds `window.conduit.inputs` with a frozen copy of
/// those values (`Object.defineProperty`'d before the whole object is
/// frozen, so the getter itself survives the freeze). A later `{ type,
/// event: 'inputs-changed', inputs }` message from `parent` swaps the
/// current values and dispatches `new CustomEvent('conduit:inputs-changed',
/// { detail: inputs })` on `window` — the page's only way to learn a value
/// changed, since `window.conduit` itself stays the same frozen object.
export function buildPageBridgeScript(capabilities: string[], inputs?: Record<string, unknown> | null): string {
  const hasStorage = capabilities.includes('storage');
  const hasInputs = inputs != null;
  const capsLiteral = JSON.stringify(capabilities);
  const inputsLiteral = hasInputs ? JSON.stringify(inputs) : 'null';
  return (
    `(function(){var TYPE='${PAGE_BRIDGE_MESSAGE_TYPE}';var seq=0,pending={};` +
    `function call(method,params){return new Promise(function(resolve,reject){` +
    `var id='b'+(++seq);pending[id]={resolve:resolve,reject:reject};` +
    `parent.postMessage({type:TYPE,id:id,method:method,params:params},'*');});}` +
    (hasInputs ? `var currentInputs=${inputsLiteral};` : '') +
    `window.addEventListener('message',function(e){if(e.source!==parent)return;var d=e.data;` +
    `if(!d||d.type!==TYPE)return;` +
    (hasInputs
      ? `if(d.event==='inputs-changed'){currentInputs=d.inputs||{};` +
        `window.dispatchEvent(new CustomEvent('conduit:inputs-changed',{detail:currentInputs}));return;}`
      : '') +
    `var p=pending[d.id];if(!p)return;delete pending[d.id];` +
    `if(d.ok){p.resolve(d.result);return;}` +
    `var info=d.error||{};var err=new Error(info.message||'Storage error.');` +
    `if(info.code)err.code=info.code;p.reject(err);});` +
    (hasStorage
      ? `var storage=Object.freeze({` +
        `get:function(key){return call('storage.get',{key:key});},` +
        `set:function(key,value){var json;try{json=JSON.stringify(value);}catch(e){json=undefined;}` +
        `if(json===undefined){var err=new Error('This value cannot be stored: it is not JSON-serializable.');` +
        `err.code='invalid';return Promise.reject(err);}` +
        `return call('storage.set',{key:key,value:value});},` +
        `'delete':function(key){return call('storage.delete',{key:key});},` +
        `keys:function(prefix){return call('storage.keys',{prefix:prefix});}` +
        `});`
      : '') +
    `var conduit={version:2,capabilities:${capsLiteral}` +
    (hasStorage ? `,storage:storage` : '') +
    `};` +
    (hasInputs
      ? `Object.defineProperty(conduit,'inputs',{enumerable:true,get:function(){` +
        `return Object.freeze(Object.assign({},currentInputs));}});`
      : '') +
    `window.conduit=Object.freeze(conduit);` +
    `})();`
  );
}

/// Parse a bridge request from the frame; `null` unless it is well formed:
/// a known method, an id string no longer than 64 characters, and a `params`
/// object whose shape matches the method (a string `key`, an optional string
/// `prefix`, a `value` present for `storage.set`).
export function parsePageBridgeRequest(data: unknown): PageBridgeRequest | null {
  if (data == null || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.type !== PAGE_BRIDGE_MESSAGE_TYPE) return null;
  if (typeof d.id !== 'string' || d.id.length === 0 || d.id.length > 64) return null;
  if (typeof d.method !== 'string' || !PAGE_BRIDGE_METHODS.has(d.method)) return null;
  const method = d.method as PageBridgeMethod;
  const params = d.params;
  if (params == null || typeof params !== 'object' || Array.isArray(params)) return null;
  const p = params as Record<string, unknown>;
  switch (method) {
    case 'storage.get':
    case 'storage.delete':
      if (typeof p.key !== 'string') return null;
      return { id: d.id, method, params: { key: p.key } };
    case 'storage.set':
      if (typeof p.key !== 'string') return null;
      if (!('value' in p)) return null;
      return { id: d.id, method, params: { key: p.key, value: p.value } };
    case 'storage.keys':
      if (p.prefix !== undefined && typeof p.prefix !== 'string') return null;
      return { id: d.id, method, params: p.prefix === undefined ? {} : { prefix: p.prefix } };
    default:
      return null;
  }
}
