/**
 * Sample artifacts for `?route=artifacts` (see `devRoute.ts`).
 *
 * `dev:web` runs the renderer with no backend, so the artifact panel can only
 * ever show its empty state there — nothing to design against, and nothing for
 * the layout suite to measure. These are inline-payload artifacts, which the
 * panel renders without any IPC, chosen to stress width the way real ones do:
 * an HTML page laid out for a desktop viewport, a Markdown report with a wide
 * table, and a code file with long lines.
 *
 * Imported only behind `import.meta.env.DEV`, so none of this reaches a
 * production bundle.
 */

import type { Artifact } from '../ipc/contracts';

export const FIXTURE_CONVERSATION_ID = 'dev-fixture-conversation';

const now = '2026-09-13T12:00:00Z';

// i18n-exempt: dev-only fixture content, never shipped (imported behind import.meta.env.DEV).
const DASHBOARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Usage dashboard</title>
<style>
  body { margin: 0; font: 14px/1.45 system-ui, sans-serif; background: #f6f5f1; color: #1f1e1d; }
  header { display: flex; justify-content: space-between; align-items: center; padding: 20px 28px; border-bottom: 1px solid #e4e1d8; background: #fff; }
  h1 { font-size: 18px; margin: 0; }
  .range { display: flex; gap: 6px; }
  .range span { padding: 5px 10px; border: 1px solid #e4e1d8; border-radius: 6px; font-size: 12px; }
  .range .on { background: #1f1e1d; color: #fff; border-color: #1f1e1d; }
  main { padding: 24px 28px; display: grid; gap: 16px; }
  .kpis { display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 16px; }
  .card { background: #fff; border: 1px solid #e4e1d8; border-radius: 10px; padding: 16px; }
  .card small { color: #6b675d; display: block; margin-bottom: 6px; }
  .card b { font-size: 24px; }
  .row { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eeebe3; white-space: nowrap; }
  th { color: #6b675d; font-weight: 500; }
</style></head>
<body>
<header><h1>Usage dashboard</h1><div class="range"><span>7d</span><span class="on">30d</span><span>90d</span></div></header>
<main>
  <section class="kpis">
    <div class="card"><small>Requests</small><b>48,210</b></div>
    <div class="card"><small>Tokens in</small><b>12.4M</b></div>
    <div class="card"><small>Tokens out</small><b>3.1M</b></div>
    <div class="card"><small>Spend</small><b>$184.20</b></div>
  </section>
  <section class="row">
    <div class="card"><small>Requests per day</small>
      <svg viewBox="0 0 600 180" width="100%" height="180" role="img" aria-label="Requests per day">
        <polyline fill="none" stroke="#c2623f" stroke-width="3" points="0,140 40,120 80,130 120,90 160,100 200,70 240,80 280,60 320,75 360,50 400,65 440,40 480,55 520,30 560,45 600,20"/>
      </svg>
    </div>
    <div class="card"><small>By model</small>
      <table><thead><tr><th>Model</th><th>Share</th><th>Spend</th></tr></thead>
      <tbody><tr><td>claude-sonnet-4</td><td>61%</td><td>$112.40</td></tr><tr><td>gpt-4.1-mini</td><td>27%</td><td>$41.30</td></tr><tr><td>llama-3.3-70b</td><td>12%</td><td>$30.50</td></tr></tbody></table>
    </div>
  </section>
</main>
</body></html>`;

const REPORT_MARKDOWN = `# Q3 launch readiness

A summary of where each workstream stands two weeks before launch.

## Workstreams

| Workstream | Owner | Status | Risk | Next milestone | Notes |
| --- | --- | --- | --- | --- | --- |
| Billing migration | Platform | On track | Low | Dual-write cutover (Sep 20) | Shadow traffic clean for 9 days |
| Onboarding flow | Growth | At risk | Medium | Copy freeze (Sep 18) | Two locales still in review |
| Status page | SRE | On track | Low | Public preview (Sep 22) | Synthetic checks green |
| Docs site | DevRel | Behind | High | API reference regen | Generator blocked on schema export |

## Decisions needed

1. Whether to ship the onboarding flow behind a flag in the two unreviewed locales.
2. Whether the docs regeneration can slip one week without moving launch.

> The launch date holds if both decisions land by Friday.
`;

const CODE_TS = `import { setTimeout as sleep } from 'node:timers/promises';

/** A token-bucket rate limiter with jittered backoff for callers that exceed it. */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(private readonly capacity: number, private readonly refillPerSecond: number) {
    this.tokens = capacity;
  }

  async acquire(cost = 1, { maxWaitMs = 30_000, signal }: { maxWaitMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    const deadline = Date.now() + maxWaitMs;
    for (let attempt = 0; ; attempt++) {
      this.refill();
      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }
      const waitMs = Math.min(deadline - Date.now(), this.backoff(attempt, cost));
      if (waitMs <= 0) throw new Error(\`rate limit: could not acquire \${cost} token(s) within \${maxWaitMs}ms\`);
      await sleep(waitMs, undefined, { signal });
    }
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.lastRefill) / 1000) * this.refillPerSecond);
    this.lastRefill = now;
  }

  private backoff(attempt: number, cost: number): number {
    const deficit = cost - this.tokens;
    const base = (deficit / this.refillPerSecond) * 1000;
    return base * 2 ** Math.min(attempt, 5) * (0.5 + Math.random() / 2);
  }
}
`;

export const FIXTURE_ARTIFACTS: Artifact[] = [
  {
    id: 'dev-fixture-dashboard',
    conversationId: FIXTURE_CONVERSATION_ID,
    kind: 'html',
    title: 'usage-dashboard.html',
    mimeType: 'text/html',
    contentText: DASHBOARD_HTML,
    createdAt: now,
  },
  {
    id: 'dev-fixture-report',
    conversationId: FIXTURE_CONVERSATION_ID,
    kind: 'markdown',
    title: 'q3-launch-readiness.md',
    mimeType: 'text/markdown',
    contentText: REPORT_MARKDOWN,
    createdAt: now,
  },
  {
    id: 'dev-fixture-code',
    conversationId: FIXTURE_CONVERSATION_ID,
    kind: 'code',
    title: 'rate-limiter.ts',
    mimeType: 'text/typescript',
    contentText: CODE_TS,
    createdAt: now,
  },
];
