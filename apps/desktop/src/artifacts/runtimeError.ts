/// Errors thrown by an HTML artifact's own scripts, reported to the app.
///
/// Live, a dashboard the model wrote had `const` without an initializer: the
/// script never ran, the KPI tiles and both charts stayed empty, and nothing
/// said why. The preview now reports the first error so the reader can see it
/// and ask the model to fix it.

export const ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE = 'conduit:artifact-runtime-error';

/// Longest message forwarded; a minified stack in `message` is not useful.
const MAX_MESSAGE = 300;

export interface ArtifactRuntimeError {
  message: string;
  line?: number;
}

/// Trusted reporter (Conduit-owned, not model content). Registered in the head,
/// before the artifact's scripts, so their syntax errors are caught too. Only
/// the first error per load is posted; one broken script can throw on every
/// animation frame.
///
/// A `<script src>` that fails to load is reported too, by URL. Live, a map
/// page gave leaflet.js a made-up `integrity` hash: the browser refused the
/// file, and the only error was the later "L is not defined", which told
/// neither the reader nor the model asked to fix it what was wrong. Load
/// errors do not bubble, so that listener runs in the capture phase.
export const ARTIFACT_RUNTIME_ERROR_SCRIPT =
  `(function(){var sent=false;function post(m,l){if(sent)return;sent=true;` +
  `parent.postMessage({type:'${ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE}',message:String(m||'Error').slice(0,${MAX_MESSAGE}),line:l||0},'*');}` +
  `window.addEventListener('error',function(e){var t=e&&e.target;if(t&&t!==window&&t.tagName==='SCRIPT'&&t.src)` +
  `post('Could not load script '+t.src+(t.integrity?' (its integrity hash may not match the file)':''),0);},true);` +
  `window.addEventListener('error',function(e){if(e&&e.target&&e.target!==window)return;post(e.message,e.lineno);});` +
  `window.addEventListener('unhandledrejection',function(e){var r=e&&e.reason;post(r&&r.message?r.message:r,0);});` +
  `})();`;

/// Parse a postMessage payload from the artifact iframe; `null` unless it is a
/// well-formed runtime error report.
export function parseArtifactRuntimeErrorMessage(data: unknown): ArtifactRuntimeError | null {
  if (data == null || typeof data !== 'object') return null;
  const payload = data as { type?: unknown; message?: unknown; line?: unknown };
  if (payload.type !== ARTIFACT_RUNTIME_ERROR_MESSAGE_TYPE) return null;
  if (typeof payload.message !== 'string' || !payload.message.trim()) return null;
  const line = typeof payload.line === 'number' && payload.line > 0 ? Math.floor(payload.line) : undefined;
  return { message: payload.message.slice(0, MAX_MESSAGE), line };
}
