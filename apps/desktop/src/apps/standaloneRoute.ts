/// The `?app=<id>` route: Rust opens an app's own window at `index.html?app=<id>`
/// (window label `app-<id>`). Only the id shape Rust mints is accepted, so a
/// hand-built URL cannot smuggle anything else into an IPC call.

const APP_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function parseStandaloneAppRoute(search: string): string | null {
  const id = new URLSearchParams(search).get('app');
  return id != null && APP_ID_PATTERN.test(id) ? id : null;
}
