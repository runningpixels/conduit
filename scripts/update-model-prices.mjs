// Refresh the bundled model price snapshot from models.dev.
//
// Conduit never fetches prices at runtime from a third party: the app embeds
// crates/provider-core/data/model-prices.json at build time, and this script is
// how that file is refreshed (before each release -- see docs/release/checklist.md).
// models.dev is an open, MIT-licensed catalog of model prices maintained by the
// opencode team and used by Chatbox, Cherry Studio, Cline and others.
//
//   node scripts/update-model-prices.mjs            write the snapshot
//   node scripts/update-model-prices.mjs --check    report its age, exit 1 if over 60 days
//
// Only the four base prices are kept (USD per million tokens): input, output,
// cache read, cache write. Long-context tiers are dropped on purpose: usage is
// stored per turn with tokens summed across agent rounds, so a per-request tier
// cannot be applied honestly (see the pricing module's docs).
import { readFileSync, writeFileSync } from 'node:fs';

const SOURCE = 'https://models.dev/api.json';
const OUT = 'crates/provider-core/data/model-prices.json';
const MAX_AGE_DAYS = 60;

// Conduit provider id -> models.dev provider key. Ollama, LM Studio and the
// generic OpenAI-compatible provider are absent: local models cost nothing per
// token, and a custom endpoint's prices are unknowable (users set an override).
export const PROVIDER_KEYS = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'google',
  openrouter: 'openrouter',
  opencode_zen: 'opencode',
  groq: 'groq',
  deepseek: 'deepseek',
  mistral: 'mistral',
  xai: 'xai',
  zai: 'zai',
  moonshot: 'moonshotai',
  qwen: 'alibaba',
  together: 'togetherai',
  fireworks: 'fireworks-ai',
};

if (process.argv.includes('--check')) {
  const snapshot = JSON.parse(readFileSync(OUT, 'utf8'));
  const ageDays = Math.floor((Date.now() - Date.parse(snapshot.fetchedAt)) / 86_400_000);
  console.log(`model-prices: snapshot fetched ${snapshot.fetchedAt} (${ageDays} days ago)`);
  if (ageDays > MAX_AGE_DAYS) {
    console.error(`model-prices: older than ${MAX_AGE_DAYS} days -- run node scripts/update-model-prices.mjs`);
    process.exit(1);
  }
  process.exit(0);
}

const response = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) {
  console.error(`model-prices: ${SOURCE} returned ${response.status}`);
  process.exit(1);
}
const catalog = await response.json();

/** A price must be a finite, non-negative number to be kept. */
const price = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined);

const providers = {};
let modelCount = 0;
for (const [conduitId, key] of Object.entries(PROVIDER_KEYS)) {
  const models = catalog[key]?.models;
  if (!models) {
    console.error(`model-prices: models.dev has no provider "${key}" (for ${conduitId})`);
    process.exit(1);
  }
  const entries = {};
  for (const id of Object.keys(models).sort()) {
    const cost = models[id].cost;
    const input = price(cost?.input);
    const output = price(cost?.output);
    // A model with no input or output price is unpriced, not free: leave it out
    // so the app says "no price" instead of charting $0.
    if (input === undefined || output === undefined) continue;
    const entry = { i: input, o: output };
    const cacheRead = price(cost.cache_read);
    const cacheWrite = price(cost.cache_write);
    if (cacheRead !== undefined) entry.cr = cacheRead;
    if (cacheWrite !== undefined) entry.cw = cacheWrite;
    entries[id] = entry;
    modelCount += 1;
  }
  providers[conduitId] = entries;
}

const snapshot = {
  source: SOURCE,
  license: 'MIT (models.dev)',
  fetchedAt: new Date().toISOString().slice(0, 10),
  units: 'USD per million tokens; i=input, o=output, cr=cache read, cw=cache write',
  providers,
};

// One model per line keeps refresh diffs readable in review.
const lines = ['{'];
for (const field of ['source', 'license', 'fetchedAt', 'units']) {
  lines.push(`  ${JSON.stringify(field)}: ${JSON.stringify(snapshot[field])},`);
}
lines.push('  "providers": {');
const providerIds = Object.keys(providers);
providerIds.forEach((providerId, p) => {
  lines.push(`    ${JSON.stringify(providerId)}: {`);
  const ids = Object.keys(providers[providerId]);
  ids.forEach((id, m) => {
    const comma = m < ids.length - 1 ? ',' : '';
    lines.push(`      ${JSON.stringify(id)}: ${JSON.stringify(providers[providerId][id])}${comma}`);
  });
  lines.push(`    }${p < providerIds.length - 1 ? ',' : ''}`);
});
lines.push('  }', '}', '');
writeFileSync(OUT, lines.join('\n'));
console.log(`model-prices: wrote ${modelCount} models across ${providerIds.length} providers to ${OUT}`);
