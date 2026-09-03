import type { ToolDefinition } from '@conduit/config-schema';
import type { Artifact } from '../ipc/contracts';
import type { AssistantStreamState, ToolCallState } from './streamState';
import type { DocumentTurnIntent } from './documentTurnIntent';
import { appName } from '../brand';
import { allowUserBranding } from '../brand/buildFlags';

const DOCUMENT_TOOL_GROUP = 'Documents';
const BRAND_TOOL_GROUP = 'Branding';

function schema(fields: Array<{ name: string; type: string; required?: boolean }>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const field of fields) {
    properties[field.name] = { type: field.type };
    if (field.required) required.push(field.name);
  }
  return required.length > 0
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}

/**
 * The 18-key curated brand palette surface (white-label plan §2). Kept as one
 * array so the dark/light schema halves and the actual palette object in a
 * tool call are checked against the exact same key list — a key added to one
 * and not the other is precisely the drift this mirrors against the Rust
 * side.
 */
const BRAND_PALETTE_KEYS = [
  'bg',
  'bgSide',
  'card',
  'cardHi',
  'line',
  'lineSoft',
  'lineHi',
  'ink',
  'ink2',
  'ink3',
  'hue',
  'hueText',
  'hueSolid',
  'onHue',
  'ok',
  'warn',
  'err',
  'link',
] as const;

/** One theme's worth of the brand palette: all 18 keys, all required, all strings (hex — the tool description states the grammar; JSON Schema has no regex-pattern support worth relying on here, so this is enforced by the Rust validator, not this shape). */
function brandPaletteSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of BRAND_PALETTE_KEYS) {
    properties[key] = { type: 'string' };
  }
  return { type: 'object', properties, required: [...BRAND_PALETTE_KEYS] };
}

/**
 * `write_brand_theme`'s input schema. Deliberately camelCase, unlike the
 * older `artifact_id`-shaped document tools: this tool's arguments
 * deserialize straight into `BrandConfig` (ts-rs-generated, camelCase) on
 * the Rust side rather than into a bespoke tool-args struct, so there is no
 * snake_case boundary to cross.
 */
function brandThemeInputSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      appName: { type: 'string' },
      displayName: { type: 'string' },
      tagline: { type: 'string' },
      notes: { type: 'string' },
      dark: brandPaletteSchema(),
      light: brandPaletteSchema(),
    },
    required: ['appName', 'displayName', 'dark', 'light'],
  };
}

export function builtinToolDefinitions(): ToolDefinition[] {
  return [
  {
    toolId: 'write_html_document',
    name: 'write_html_document',
    description:
      `Create a new HTML document artifact. Use only when the user explicitly asked to create HTML content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — ${appName()} assigns IDs. After creating, revise with edit_html_document and the returned artifact_id; do not call write_html_document again for the same document.`,
    inputSchema: schema([
      { name: 'title', type: 'string' },
      { name: 'html', type: 'string', required: true },
      { name: 'artifact_id', type: 'string' },
      { name: 'filename', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'edit_html_document',
    name: 'edit_html_document',
    description:
      'Replace the full contents of an existing HTML document artifact. Use only when the user explicitly asked to revise an existing HTML document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'updated_html', type: 'string', required: true },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'write_markdown_document',
    name: 'write_markdown_document',
    description:
      `Create a new Markdown document artifact. Use only when the user explicitly asked to create Markdown content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — ${appName()} assigns IDs. After creating, revise with edit_markdown_document and the returned artifact_id; do not call write_markdown_document again for the same document.`,
    inputSchema: schema([
      { name: 'title', type: 'string' },
      { name: 'markdown', type: 'string', required: true },
      { name: 'artifact_id', type: 'string' },
      { name: 'filename', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'edit_markdown_document',
    name: 'edit_markdown_document',
    description:
      'Replace the full contents of an existing Markdown document artifact. Use only when the user explicitly asked to revise an existing Markdown document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'updated_markdown', type: 'string', required: true },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'write_text_document',
    name: 'write_text_document',
    description:
      `Create a new plain-text document artifact. Use only when the user explicitly asked to create plain-text content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — ${appName()} assigns IDs. After creating, revise with edit_text_document and the returned artifact_id; do not call write_text_document again for the same document.`,
    inputSchema: schema([
      { name: 'title', type: 'string' },
      { name: 'text', type: 'string', required: true },
      { name: 'mime_type', type: 'string' },
      { name: 'artifact_id', type: 'string' },
      { name: 'filename', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'edit_text_document',
    name: 'edit_text_document',
    description:
      'Replace the full contents of an existing plain-text document artifact. Use only when the user explicitly asked to revise an existing plain-text document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'updated_text', type: 'string', required: true },
      { name: 'mime_type', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'export_document',
    name: 'export_document',
    description:
      'Export an existing document artifact to disk. Use only when the user explicitly asked to export or save a document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'include_metadata_sidecar', type: 'boolean' },
    ]),
    permissionLevel: 'sensitive',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  // ---------------------------------------------------------------------------
  // Utility tools (ReadOnly — always injected, no MCP needed)
  // ---------------------------------------------------------------------------
  {
    toolId: 'current_time',
    name: 'current_time',
    description: 'Get the current date and time in ISO-8601 format. No arguments needed.',
    inputSchema: schema([]),
    permissionLevel: 'readOnly',
    displayGroup: 'Utilities',
  },
  {
    toolId: 'uuid',
    name: 'uuid',
    description: 'Generate a new UUID v4. No arguments needed.',
    inputSchema: schema([]),
    permissionLevel: 'readOnly',
    displayGroup: 'Utilities',
  },
  {
    toolId: 'random',
    name: 'random',
    description: 'Generate a random integer in a range. Provide `min` (default 0) and `max` (default 100).',
    inputSchema: schema([
      { name: 'min', type: 'integer' },
      { name: 'max', type: 'integer' },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Utilities',
  },
  {
    toolId: 'calculator',
    name: 'calculator',
    description: 'Evaluate a simple arithmetic expression. Accepts `expression` (e.g. "(5 + 3) * 2"). Uses safe evaluation — no code execution.',
    inputSchema: schema([
      { name: 'expression', type: 'string', required: true },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Utilities',
  },
  {
    toolId: 'ask_user',
    name: 'ask_user',
    description:
      'Ask the user a short structured question mid-turn (up to 4 fields). Provide `title` and `fields` (array of {id, prompt, type: text|choice, options?}). Wait for the user\'s answers before continuing.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        fields: {
          type: 'array',
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              prompt: { type: 'string' },
              type: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'prompt', 'type'],
          },
        },
      },
      required: ['title', 'fields'],
    },
    permissionLevel: 'readOnly',
    displayGroup: 'Utilities',
  },
  // ---------------------------------------------------------------------------
  // Web tools (search-gated)
  // ---------------------------------------------------------------------------
  {
    toolId: 'web_search',
    name: 'web_search',
    description:
      'Search the web via the configured local search backend. Provide a `query` string. Returns up to 10 results with titles, snippets, and URLs. Empty results mean no hit — do not retry similar queries.',
    inputSchema: schema([
      { name: 'query', type: 'string', required: true },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Web',
  },
  {
    toolId: 'web_fetch',
    name: 'web_fetch',
    description: 'Fetch the contents of a web page. Provide a `url` string. Returns the page content as text (may be truncated at 50KB).',
    inputSchema: schema([
      { name: 'url', type: 'string', required: true },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Web',
  },
  // ---------------------------------------------------------------------------
  // Clipboard tools
  // ---------------------------------------------------------------------------
  {
    toolId: 'clipboard_read',
    name: 'clipboard_read',
    description: 'Read the current contents of the system clipboard. Returns text content if available.',
    inputSchema: schema([]),
    permissionLevel: 'sideEffectful',
    displayGroup: 'Clipboard',
  },
  {
    toolId: 'clipboard_write',
    name: 'clipboard_write',
    description: 'Write text to the system clipboard. Provide `text` to copy.',
    inputSchema: schema([
      { name: 'text', type: 'string', required: true },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: 'Clipboard',
  },
  // ---------------------------------------------------------------------------
  // Workspace file tools (settings-gated)
  // ---------------------------------------------------------------------------
  {
    toolId: 'workspace_read',
    name: 'workspace_read',
    description:
      'Read a text file under the workspace folder. Path must be relative to the workspace root. Optional offset/limit in bytes.',
    inputSchema: schema([
      { name: 'path', type: 'string', required: true },
      { name: 'offset', type: 'integer' },
      { name: 'limit', type: 'integer' },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Workspace',
  },
  {
    toolId: 'workspace_write',
    name: 'workspace_write',
    description:
      'Create or overwrite a text file under the workspace folder. Path is relative to the workspace root. Set create_dirs=true to create parent directories.',
    inputSchema: schema([
      { name: 'path', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
      { name: 'create_dirs', type: 'boolean' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: 'Workspace',
  },
  {
    toolId: 'workspace_edit',
    name: 'workspace_edit',
    description:
      'Replace the full contents of an existing text file under the workspace folder. Path is relative to the workspace root.',
    inputSchema: schema([
      { name: 'path', type: 'string', required: true },
      { name: 'content', type: 'string', required: true },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: 'Workspace',
  },
  {
    toolId: 'workspace_glob',
    name: 'workspace_glob',
    description:
      'List files under the workspace folder matching a glob pattern (relative to the workspace root), e.g. "**/*.rs".',
    inputSchema: schema([
      { name: 'pattern', type: 'string', required: true },
      { name: 'max_results', type: 'integer' },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Workspace',
  },
  {
    toolId: 'workspace_grep',
    name: 'workspace_grep',
    description:
      'Search file contents under the workspace folder with a regex. Optional path (subdirectory) and glob filter (e.g. "*.ts").',
    inputSchema: schema([
      { name: 'pattern', type: 'string', required: true },
      { name: 'path', type: 'string' },
      { name: 'glob', type: 'string' },
      { name: 'max_matches', type: 'integer' },
      { name: 'case_insensitive', type: 'boolean' },
    ]),
    permissionLevel: 'readOnly',
    displayGroup: 'Workspace',
  },
  // ---------------------------------------------------------------------------
  // Branding tool (white-label plan §4, Phase 4)
  // ---------------------------------------------------------------------------
  {
    toolId: 'write_brand_theme',
    name: 'write_brand_theme',
    description:
      `Propose a white-label theme for ${appName()}: a name and a full dark+light colour palette (18 keys each, hex only). This creates a reviewable Markdown artifact (brand.md) — it does not change anything in the running app by itself; the user previews or applies it explicitly from the document panel. Use only when the user explicitly asked to design, generate, or change the app's brand, theme, or colour scheme.`,
    inputSchema: brandThemeInputSchema(),
    permissionLevel: 'sideEffectful',
    displayGroup: BRAND_TOOL_GROUP,
  },
  ];
}

/**
 * The Documents group only.
 *
 * This was built from *every* builtin definition, so `uuid`, `calculator`,
 * `web_search` and the clipboard tools all counted as document tools. A `uuid`
 * call then rendered through `summarizeDocumentToolCall`, where the action and
 * kind lookups miss and fall through to `?? 'Document'` and the content field
 * is absent — printing "Documents / Document · Document / lines 0 / Document
 * updated." for a tool that touched no document at all.
 */
export const DOCUMENT_TOOL_NAMES = new Set(
  builtinToolDefinitions().filter((tool) => tool.displayGroup === DOCUMENT_TOOL_GROUP).map(
    (tool) => tool.name,
  ),
);

/** Document tools that create or edit content (excludes export). */
export const DOCUMENT_CONTENT_TOOL_NAMES = new Set(
  [...DOCUMENT_TOOL_NAMES].filter((name) => name !== 'export_document'),
);

export type DocumentToolPhase = 'start' | 'complete' | 'error';

export interface DocumentToolActivity {
  phase: DocumentToolPhase;
  toolName: string;
  titleHint?: string;
  /** Present for edit_* tools once arguments are known. */
  artifactId?: string;
  /** Failure reason on `phase: 'error'`, shown in the document panel. */
  error?: string;
}

export function isDocumentContentTool(name: string): boolean {
  return DOCUMENT_CONTENT_TOOL_NAMES.has(name);
}

export function isDocumentCreateTool(name: string): boolean {
  return name.startsWith('write_') && DOCUMENT_CONTENT_TOOL_NAMES.has(name);
}

export function documentToolArtifactKind(toolName: string): Artifact['kind'] {
  if (toolName.includes('html')) return 'html';
  if (toolName.includes('markdown')) return 'markdown';
  if (toolName.includes('json')) return 'json';
  if (toolName.includes('code')) return 'code';
  return 'text';
}

const UTILITY_TOOL_NAMES = new Set(['current_time', 'uuid', 'random', 'calculator', 'ask_user']);
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch']);
const WORKSPACE_TOOL_GROUP = 'Workspace';

export const WORKSPACE_TOOL_NAMES = new Set(
  builtinToolDefinitions()
    .filter((tool) => tool.displayGroup === WORKSPACE_TOOL_GROUP)
    .map((tool) => tool.name),
);

/** Local `web_search` + `web_fetch`. Only offer when the turn
 *  resolved to the local search backend — never alongside hosted search. */
export function selectBuiltinWebTools(): ToolDefinition[] {
  return builtinToolDefinitions().filter((t) => WEB_TOOL_NAMES.has(t.name));
}

/** Resolve the active workspace root for a turn (conversation bind wins). */
export function resolveActiveWorkspaceRoot(
  conversationRoot: string | null | undefined,
  settings: {
    workspaceToolsEnabled?: boolean;
    workspaceRoot?: string | null;
    workspaceToolsConsentAcknowledged?: boolean;
  },
): string | null {
  const fromConversation = conversationRoot?.trim() || null;
  if (fromConversation) return fromConversation;
  if (
    settings.workspaceToolsEnabled &&
    settings.workspaceToolsConsentAcknowledged &&
    settings.workspaceRoot?.trim()
  ) {
    return settings.workspaceRoot.trim();
  }
  return null;
}

/** Workspace file tools — when a conversation or settings default root is active. */
export function selectBuiltinWorkspaceTools(
  settings: {
    workspaceToolsEnabled?: boolean;
    workspaceRoot?: string | null;
    workspaceToolsConsentAcknowledged?: boolean;
  },
  conversationRoot?: string | null,
): ToolDefinition[] {
  if (!resolveActiveWorkspaceRoot(conversationRoot, settings)) {
    return [];
  }
  return builtinToolDefinitions().filter((t) => WORKSPACE_TOOL_NAMES.has(t.name));
}

/** Basename for chip display (Windows + POSIX). */
export function workspaceFolderLabel(root: string): string {
  const normalized = root.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || root;
}

/** Built-in document tools exposed to the model for a given turn intent. */
export function selectBuiltinDocumentTools(intent: DocumentTurnIntent): ToolDefinition[] {
  const utilityTools = builtinToolDefinitions().filter((t) => UTILITY_TOOL_NAMES.has(t.name));
  switch (intent) {
    case 'create':
      // Include edit_* so mid-turn revisions use the returned artifact_id
      // instead of spawning duplicate documents via another write_*.
      return [
        ...utilityTools,
        ...builtinToolDefinitions().filter(
          (tool) =>
            tool.name.startsWith('write_') ||
            tool.name.startsWith('edit_') ||
            tool.name === 'export_document',
        ),
      ];
    case 'edit':
      return [
        ...utilityTools,
        ...builtinToolDefinitions().filter(
          (tool) => tool.name.startsWith('edit_') || tool.name === 'export_document',
        ),
      ];
    case 'info':
    case 'general':
    default:
      return utilityTools;
  }
}

/**
 * `write_brand_theme`, gated on brand-theme intent rather than always
 * present. Its schema is much larger than any document tool's (two nested
 * 18-key objects), and unlike document creation there is no existing
 * artifact-in-scope signal to widen the gate for — so this stays a plain
 * boolean the caller computes from the prompt (`looksLikeBrandThemeRequest`,
 * `chat/brandPrompt.ts`), mirroring how `selectBuiltinDocumentTools` takes an
 * already-classified `DocumentTurnIntent` rather than classifying itself.
 *
 * Also gated on `allowUserBranding` (`brand/buildFlags.ts`), read directly
 * here rather than threaded in as a parameter, so this holds regardless of
 * what any caller passes as `brandIntent`: a Mode B build with
 * `allowUserBranding = false` can never apply a `write_brand_theme` result
 * (every persisting write refuses server-side — see
 * `commands::branding::guard_write`/`ALLOW_USER_BRANDING`), so offering the
 * tool at all would be a dead end regardless of how strong the user's intent
 * looked — the model would spend a tool call, and tokens on its ~20-key
 * schema, producing a document `DocumentPanel` cannot let the user apply
 * anyway (see its own `brandingPermitted` check).
 */
export function selectBuiltinBrandTools(brandIntent: boolean): ToolDefinition[] {
  if (!brandIntent || !allowUserBranding) return [];
  return builtinToolDefinitions().filter((tool) => tool.displayGroup === BRAND_TOOL_GROUP);
}

export function completedDocumentToolCalls(state: AssistantStreamState): ToolCallState[] {
  return state.toolCalls.filter(
    (toolCall) => toolCall.status === 'completed' && DOCUMENT_TOOL_NAMES.has(toolCall.name),
  );
}

export function hadSuccessfulDocumentToolCalls(state: AssistantStreamState): boolean {
  return completedDocumentToolCalls(state).length > 0;
}

export function failedDocumentToolCalls(state: AssistantStreamState): ToolCallState[] {
  return state.toolCalls.filter(
    (toolCall) => toolCall.status === 'failed' && DOCUMENT_TOOL_NAMES.has(toolCall.name),
  );
}

export function hadFailedDocumentToolCalls(state: AssistantStreamState): boolean {
  return failedDocumentToolCalls(state).length > 0;
}

/** Pick the artifact the document panel should open after an agent turn. */
export function resolveDocumentArtifactId(
  state: AssistantStreamState,
  listed: Artifact[],
): string | undefined {
  const completed = completedDocumentToolCalls(state);
  if (completed.length === 0) return undefined;

  let artifactId: string | undefined;
  for (const toolCall of completed) {
    if (toolCall.name.startsWith('write_')) {
      const id = toolCall.arguments?.artifact_id;
      artifactId = typeof id === 'string' && id.trim() !== '' ? id : undefined;
      continue;
    }
    const id = toolCall.arguments?.artifact_id;
    if (typeof id === 'string' && id.trim() !== '') {
      artifactId = id;
    }
  }

  if (!artifactId && completed.some((toolCall) => toolCall.name.startsWith('write_'))) {
    return listed[0]?.id;
  }

  return artifactId;
}

// Content field names per document tool (for redaction + summary)
const CONTENT_FIELD_BY_TOOL: Record<string, string> = {
  write_html_document: 'html',
  edit_html_document: 'updated_html',
  write_markdown_document: 'markdown',
  edit_markdown_document: 'updated_markdown',
  write_text_document: 'text',
  edit_text_document: 'updated_text',
};

const KIND_BY_TOOL: Record<string, string> = {
  write_html_document: 'HTML',
  edit_html_document: 'HTML',
  write_markdown_document: 'Markdown',
  edit_markdown_document: 'Markdown',
  write_text_document: 'Text',
  edit_text_document: 'Text',
};

const ACTION_BY_TOOL: Record<string, string> = {
  write_html_document: 'Create',
  edit_html_document: 'Edit',
  write_markdown_document: 'Create',
  edit_markdown_document: 'Edit',
  write_text_document: 'Create',
  edit_text_document: 'Edit',
};

export interface DocumentToolSummary {
  action: string;
  kind: string;
  title?: string;
  filename?: string;
  lineCount: number;
  charCount: number;
}

/** Summarize a document tool call for compact display (no full content). */
export function summarizeDocumentToolCall(toolCall: ToolCallState): DocumentToolSummary | undefined {
  if (!DOCUMENT_TOOL_NAMES.has(toolCall.name)) return undefined;
  const args = toolCall.arguments ?? {};
  const contentField = CONTENT_FIELD_BY_TOOL[toolCall.name];
  const content = typeof args[contentField] === 'string' ? (args[contentField] as string) : '';
  const lineCount = content ? content.split('\n').length : 0;
  const charCount = content.length;
  const title = typeof args.title === 'string' ? args.title : undefined;
  const filename = typeof args.filename === 'string' ? args.filename : undefined;
  return {
    action: ACTION_BY_TOOL[toolCall.name] ?? 'Document',
    kind: KIND_BY_TOOL[toolCall.name] ?? 'Document',
    title,
    filename,
    lineCount,
    charCount,
  };
}

/// Artifact `kind` as it appears in backend error strings → display word.
const KIND_WORD: Record<string, string> = {
  markdown: 'Markdown',
  html: 'HTML',
  code: 'Code',
  json: 'JSON',
  text: 'Text',
};

/// `ensure_kind` in `src-tauri/src/agent_tools.rs` — the only tool error whose
/// wording maps to something a reader can act on.
const KIND_MISMATCH = /^artifact '[^']+' is '([^']+)' not '([^']+)'$/;

/**
 * Translate a backend tool error into plain language.
 *
 * Tool errors are written for whoever is reading a log, and the raw string was
 * previously the visible conclusion of a failed turn. Recognised errors get a
 * sentence that says what happened and what to do; everything else falls back
 * to the original text. Callers keep the raw string available either way.
 */
export function explainToolError(error: string | undefined, fallback: string): string {
  if (!error) return fallback;
  const mismatch = KIND_MISMATCH.exec(error.trim());
  if (mismatch) {
    const actual = KIND_WORD[mismatch[1]] ?? mismatch[1];
    const expected = KIND_WORD[mismatch[2]] ?? mismatch[2];
    return `This document is ${actual} and a document's format is fixed once it is created. Ask for a new ${expected} document instead of converting this one.`;
  }
  return error;
}

/** Redact the large content field(s) from arguments for compact display. */
export function redactDocumentToolArguments(
  args: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  const contentField = CONTENT_FIELD_BY_TOOL[toolName];
  if (!contentField) return args;
  const next: Record<string, unknown> = { ...args };
  if (contentField in next) {
    next[contentField] = '…';
  }
  return next;
}
