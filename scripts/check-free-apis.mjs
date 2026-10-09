// Check that every free API in the ideas catalogue still answers without a key.
//
//   node scripts/check-free-apis.mjs
//
// Reads apps/desktop/src/ideas/freeApis.json — the catalogue's data, kept as
// JSON so plain Node reads the same list the app imports (freeApis.ts types
// it), with no TypeScript loader or build step — and GETs each `example` the
// way a page's request reaches it through the artifact network proxy: its
// User-Agent family, only same-site redirects followed (the proxy's rule), a
// 5 MB cap. An API
// passes on HTTP 200 with a body that parses as JSON within 20 seconds.
//
// Prints a table and exits 1 if any API fails. Run weekly by
// .github/workflows/free-apis.yml; a failure means an idea's page will break,
// so fix or drop the API and its idea (freeApis.json, ideas/catalog.ts).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOGUE = join(ROOT, 'apps/desktop/src/ideas/freeApis.json');
const USER_AGENT = 'Conduit-Artifact/check';
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/**
 * The proxy's redirect rule (`same_site` in src-tauri/src/artifact_network.rs):
 * the same host give or take a leading `www.`, or a subdomain of the host
 * the page was allowed to reach.
 */
export function sameSite(allowedHost, targetHost) {
  const a = allowedHost.toLowerCase();
  const b = targetHost.toLowerCase();
  const strip = (h) => (h.startsWith('www.') ? h.slice(4) : h);
  return strip(a) === strip(b) || b.endsWith(`.${a}`);
}

async function readCapped(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error('body over 5 MB');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** GET `url` like the artifact proxy; resolves to `{ ok, status, detail, ms }`. */
export async function checkApi(url) {
  const started = Date.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = new URL(url);
  const allowed = current.hostname;
  try {
    for (let hop = 0; ; hop++) {
      if (current.protocol !== 'https:') return { ok: false, status: '-', detail: `not https: ${current}`, ms: Date.now() - started };
      const response = await fetch(current, {
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
      if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
        const next = new URL(response.headers.get('location'), current);
        await response.body?.cancel();
        if (!sameSite(allowed, next.hostname)) {
          return { ok: false, status: response.status, detail: `cross-site redirect to ${next.hostname}`, ms: Date.now() - started };
        }
        if (hop >= MAX_REDIRECTS) return { ok: false, status: response.status, detail: 'too many redirects', ms: Date.now() - started };
        current = next;
        continue;
      }
      const body = await readCapped(response);
      const ms = Date.now() - started;
      if (response.status !== 200) return { ok: false, status: response.status, detail: body.slice(0, 80).replace(/\s+/g, ' '), ms };
      try {
        JSON.parse(body);
      } catch {
        return { ok: false, status: 200, detail: 'body is not JSON', ms };
      }
      return { ok: true, status: 200, detail: `${body.length} bytes`, ms };
    }
  } catch (err) {
    const detail = err?.name === 'TimeoutError' ? 'timed out after 20 s' : String(err?.cause?.code ?? err?.message ?? err);
    return { ok: false, status: '-', detail, ms: Date.now() - started };
  }
}

async function main() {
  const apis = JSON.parse(readFileSync(CATALOGUE, 'utf8'));
  // A few at a time: polite to the services, and quick enough.
  const results = new Array(apis.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < apis.length) {
        const i = next++;
        results[i] = { api: apis[i], ...(await checkApi(apis[i].example)) };
      }
    }),
  );

  const rows = results.map((r) => [r.ok ? 'ok' : 'FAIL', r.api.id, String(r.status), `${r.ms} ms`, r.detail]);
  const widths = [4, ...[1, 2, 3].map((c) => Math.max(...rows.map((row) => row[c].length)))];
  for (const row of rows) {
    console.log(row.map((cell, i) => (i < 4 ? cell.padEnd(widths[i]) : cell)).join('  '));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} free APIs answered 200 JSON without a key.`);
  if (failed.length > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
