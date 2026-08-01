/*
 * Mock-data seam for the v5 workspace rail panes and document panel.
 *
 * These are PLACEHOLDER shapes behind a clear seam. Real data lands in the
 * owning phases: Phase 2 providers, Phase 4 connectors (MCP runtime),
 * Phase 5 artifacts (domain model + safe renderers), Phase 8 tenant config.
 * The renderer only DISPLAYS these — no provider/MCP/tenant logic lives here.
 */

export type ConnectorHealth = 'live' | 'warn' | 'off';
export type ConnectorChannel = 'stable' | 'beta' | 'auth' | 'off';

export interface HistoryRow {
  id: string;
  title: string;
  subtitle: string;
  ago: string;
  meta?: string;
  active?: boolean;
  tone?: 'warn';
  toneLabel?: string;
}

export interface ConnectorRow {
  id: string;
  name: string;
  subtitle: string;
  health: ConnectorHealth;
  channel: ConnectorChannel;
}

export interface ModelRow {
  id: string;
  name: string;
  subtitle: string;
  tone?: 'ok' | 'local';
  toneLabel?: string;
  rightLabel?: string;
}

export const HISTORY_ROWS: HistoryRow[] = [
  {
    id: 'h1',
    title: 'Repo triage note for Slack',
    subtitle: 'github, slack - triage-note.md open',
    ago: 'now',
    active: true,
    tone: 'warn',
    toneLabel: 'active',
  },
  {
    id: 'h2',
    title: 'Postgres schema review',
    subtitle: 'postgres - schema-notes.json missing',
    ago: '2h',
    meta: '3 artifacts',
  },
  {
    id: 'h3',
    title: 'Draft launch changelog',
    subtitle: 'artifact-only - changelog.md saved',
    ago: '1d',
    meta: '1 artifact',
  },
  {
    id: 'h4',
    title: 'Compare GPT-4o vs Sonnet',
    subtitle: 'models and provider behavior',
    ago: '3d',
    meta: 'local',
  },
];

export const CONNECTOR_ROWS: ConnectorRow[] = [
  {
    id: 'c1',
    name: 'github',
    subtitle: 'stdio - tools: list_issues, read_pr, create_comment',
    health: 'live',
    channel: 'stable',
  },
  {
    id: 'c2',
    name: 'postgres',
    subtitle: 'HTTP/SSE - read-only schema and query tools',
    health: 'live',
    channel: 'beta',
  },
  {
    id: 'c3',
    name: 'slack',
    subtitle: 'Needs sign-in before side-effectful posting tools run',
    health: 'warn',
    channel: 'auth',
  },
  {
    id: 'c4',
    name: 'filesystem',
    subtitle: 'Admin-disabled for this workspace',
    health: 'off',
    channel: 'off',
  },
];

export const MODEL_ROWS: ModelRow[] = [
  {
    id: 'm1',
    name: 'Claude Sonnet 4',
    subtitle: 'Anthropic - key stored in OS keychain',
    tone: 'ok',
    toneLabel: 'active',
  },
  {
    id: 'm2',
    name: 'GPT-4o',
    subtitle: 'OpenAI - available, not selected',
    rightLabel: 'allowed',
  },
  {
    id: 'm3',
    name: 'llama3.1:70b',
    subtitle: 'Ollama - local runtime at localhost:11434',
    tone: 'local',
    toneLabel: 'local',
  },
];

/** Connector availability pills shown in the composer caps row. */
export const COMPOSER_CAPS: Array<{ id: string; label: string; state: 'ok' | 'warn' | 'none' }> = [
  { id: 'websearch', label: 'web search', state: 'none' },
];