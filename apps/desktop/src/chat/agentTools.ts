import type { ToolDefinition } from '@conduit/config-schema';
import type { Artifact } from '../ipc/contracts';
import type { AssistantStreamState, ToolCallState } from './streamState';
import { classifyDocumentTurnIntent, type DocumentTurnIntent } from './documentTurnIntent';
import { looksLikeBrandThemeRequest } from './brandPrompt';
import { appName } from '../brand';
import { allowUserBranding } from '../brand/buildFlags';
import type { Translate } from '../i18n';
import { documentKindLabel } from '../lib/documentKind';
import { CONTENT_FIELD_BY_TOOL } from './documentWriteScan';

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
      `Create a new HTML document artifact. Use only when the user explicitly asked to create HTML content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — ${appName()} assigns IDs. After creating, revise with patch_document for targeted changes or edit_html_document to rewrite it, using the returned artifact_id; do not call write_html_document again for the same document. Give title before html so the user sees which document is being written.`,
    inputSchema: schema([
      { name: 'title', type: 'string' },
      { name: 'html', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
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
      'Replace the full contents of an existing HTML document artifact. Use only when the user explicitly asked to revise an existing HTML document and most of it changes; for targeted changes use patch_document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'updated_html', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'write_markdown_document',
    name: 'write_markdown_document',
    description:
      `Create a new Markdown document artifact. Use only when the user explicitly asked to create Markdown content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — ${appName()} assigns IDs. After creating, revise with patch_document for targeted changes or edit_markdown_document to rewrite it, using the returned artifact_id; do not call write_markdown_document again for the same document. Give title before markdown so the user sees which document is being written.`,
    inputSchema: schema([
      { name: 'title', type: 'string' },
      { name: 'markdown', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
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
      'Replace the full contents of an existing Markdown document artifact. Use only when the user explicitly asked to revise an existing Markdown document and most of it changes; for targeted changes use patch_document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'updated_markdown', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'write_text_document',
    name: 'write_text_document',
    description:
      `Create a new plain-text document artifact. Use only when the user explicitly asked to create plain-text content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — ${appName()} assigns IDs. After creating, revise with patch_document for targeted changes or edit_text_document to rewrite it, using the returned artifact_id; do not call write_text_document again for the same document. Give title before text so the user sees which document is being written.`,
    inputSchema: schema([
      { name: 'title', type: 'string' },
      { name: 'text', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
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
      'Replace the full contents of an existing plain-text document artifact. Use only when the user explicitly asked to revise an existing plain-text document and most of it changes; for targeted changes use patch_document.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'updated_text', type: 'string', required: true },
      { name: 'more_to_write', type: 'boolean' },
      { name: 'mime_type', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'patch_document',
    name: 'patch_document',
    description:
      'Change part of an existing document by exact text replacement, without rewriting the rest. Each old_text must match exactly one place in the document, as it stands after the edits before it; quote enough surrounding text to make it unique. Edits apply in order, and if any fails nothing is saved. Use it for targeted revisions, and to fill in a long document section by section after writing a skeleton with placeholder comments. Set more_to_write: true when more calls will follow in this turn.',
    inputSchema: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              old_text: { type: 'string' },
              new_text: { type: 'string' },
            },
            required: ['old_text', 'new_text'],
          },
        },
        more_to_write: { type: 'boolean' },
      },
      required: ['artifact_id', 'edits'],
    },
    permissionLevel: 'sideEffectful',
    displayGroup: DOCUMENT_TOOL_GROUP,
  },
  {
    toolId: 'read_document',
    name: 'read_document',
    description:
      'Read the current content of an existing document, optionally a range of lines (1-based, inclusive). Use it before patch_document when the exact current text is not already in the conversation.',
    inputSchema: schema([
      { name: 'artifact_id', type: 'string', required: true },
      { name: 'start_line', type: 'integer' },
      { name: 'end_line', type: 'integer' },
    ]),
    permissionLevel: 'readOnly',
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
  {
    toolId: 'remember',
    name: 'remember',
    description:
      'Propose a durable personal fact for the user to save. Provide `fact` (one short sentence) and optional `kind` (`core` or `note`). The fact is queued until the user saves it in Settings → Memory; it is not used until then.',
    inputSchema: schema([
      { name: 'fact', type: 'string', required: true },
      { name: 'kind', type: 'string' },
    ]),
    permissionLevel: 'sideEffectful',
    displayGroup: 'Memory',
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
      'Create or overwrite a text file under the workspace folder. Path is relative to the workspace root. Set create_dirs=true to create parent directories. Use only for files the user wants in their project; to create a document for the user to view in the app, use write_html_document, write_markdown_document or write_text_document.',
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
  [...DOCUMENT_TOOL_NAMES].filter((name) => name !== 'export_document' && name !== 'read_document'),
);

/** `complete`: the model finished the arguments. `written`: the tool saved the document. */
export type DocumentToolPhase = 'start' | 'progress' | 'complete' | 'written' | 'error';

/** How much of a streaming document has arrived — see `documentWriteScan.ts`. */
export interface DocumentWriteProgress {
  contentChars: number;
  contentLines: number;
  /** Last time an argument fragment arrived; drives "still working". */
  lastActivityAt: number;
}

export interface DocumentToolActivity {
  phase: DocumentToolPhase;
  toolName: string;
  titleHint?: string;
  /** Present for edit_* tools once arguments are known. */
  artifactId?: string;
  /** Failure reason on `phase: 'error'`, shown in the document panel. */
  error?: string;
  /** `phase: 'progress'` only. */
  progress?: DocumentWriteProgress;
}

export function isDocumentContentTool(name: string): boolean {
  return DOCUMENT_CONTENT_TOOL_NAMES.has(name);
}

export function isDocumentCreateTool(name: string): boolean {
  return name.startsWith('write_') && DOCUMENT_CONTENT_TOOL_NAMES.has(name);
}

/** `patch_document`: a targeted change to a document that already exists. */
export function isDocumentPatchTool(name: string): boolean {
  return name === 'patch_document';
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

/** `remember` — advertised only while Settings → Memory injection is on. */
export function selectBuiltinMemoryTools(enabled: boolean): ToolDefinition[] {
  if (!enabled) return [];
  return builtinToolDefinitions().filter((t) => t.name === 'remember');
}

/** Basename for chip display (Windows + POSIX). */
export function workspaceFolderLabel(root: string): string {
  const normalized = root.replace(/[\\/]+$/, '');
  const parts = normalized.split(/[/\\]/);
  return parts[parts.length - 1] || root;
}

/** Offered with every document write or edit: part-by-part building and targeted revisions. */
const DOCUMENT_REVISION_TOOL_NAMES = new Set(['patch_document', 'read_document']);

/** Built-in document tools exposed to the model for a given turn intent. */
export function selectBuiltinDocumentTools(intent: DocumentTurnIntent): ToolDefinition[] {
  const utilityTools = builtinToolDefinitions().filter((t) => UTILITY_TOOL_NAMES.has(t.name));
  switch (intent) {
    case 'create':
      // Include edit_* and patch_document so mid-turn revisions use the
      // returned artifact_id instead of spawning duplicate documents via
      // another write_*, and so a long document can be built in parts.
      return [
        ...utilityTools,
        ...builtinToolDefinitions().filter(
          (tool) =>
            tool.name.startsWith('write_') ||
            tool.name.startsWith('edit_') ||
            DOCUMENT_REVISION_TOOL_NAMES.has(tool.name) ||
            tool.name === 'export_document',
        ),
      ];
    case 'edit':
      return [
        ...utilityTools,
        ...builtinToolDefinitions().filter(
          (tool) =>
            tool.name.startsWith('edit_') ||
            DOCUMENT_REVISION_TOOL_NAMES.has(tool.name) ||
            tool.name === 'export_document',
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

/** Workspace tools that change files, as opposed to reading or searching them. */
const WORKSPACE_WRITE_TOOL_NAMES = new Set(['workspace_write', 'workspace_edit']);

/**
 * True when the prompt points at a file in the user's project: a file, folder
 * or path, or a filename with an extension ("notes.md").
 */
export function mentionsWorkspaceFileTarget(prompt: string): boolean {
  return (
    /\b(files?|folders?|director(y|ies)|paths?|repo(sitory)?|project|workspace|disk)\b/i.test(prompt) ||
    /\b[\w-]+\.(html?|md|markdown|txt|json|csv|ya?ml|toml|css|scss|jsx?|tsx?|py|rs|go|java|rb|sh)\b/i.test(prompt)
  );
}

/**
 * The built-in tools for one turn: document, brand, workspace and memory tools.
 * Web and connector tools are resolved separately by the caller.
 *
 * One function because three call sites in `ChatView.tsx` (the request itself
 * and two token estimates) used to assemble this list independently, and the
 * estimates must match what is actually sent.
 *
 * On a document turn, workspace *write* tools are left out unless the prompt
 * names a file, folder or path: two tools that can both "write an HTML file"
 * left the choice to the model, which picked `workspace_write` and produced a
 * file on disk instead of a document in the panel. Read and search tools stay,
 * so the model can still use project files as source material.
 */
export function selectBuiltinTurnTools(
  prompt: string,
  settings: {
    workspaceToolsEnabled?: boolean;
    workspaceRoot?: string | null;
    workspaceToolsConsentAcknowledged?: boolean;
    memoryEnabled: boolean;
  },
  conversationRoot?: string | null,
  /** Set by app-authored prompts (e.g. "Continue building") whose intent is
   *  known regardless of the language they are written in. */
  intentOverride?: DocumentTurnIntent,
): { intent: DocumentTurnIntent; tools: ToolDefinition[] } {
  const intent = intentOverride ?? classifyDocumentTurnIntent(prompt);
  const documentTurn = intent === 'create' || intent === 'edit';
  const workspaceTools = selectBuiltinWorkspaceTools(settings, conversationRoot).filter(
    (tool) =>
      !documentTurn || !WORKSPACE_WRITE_TOOL_NAMES.has(tool.name) || mentionsWorkspaceFileTarget(prompt),
  );
  return {
    intent,
    tools: [
      ...selectBuiltinDocumentTools(intent),
      ...selectBuiltinBrandTools(looksLikeBrandThemeRequest(prompt)),
      ...workspaceTools,
      ...selectBuiltinMemoryTools(settings.memoryEnabled),
    ],
  };
}

/**
 * Model-facing note for a turn whose only output was document writes, e.g.
 * `[Wrote HTML document "Solar System Field Guide" with write_html_document.]`.
 *
 * Success is judged as "complete and not failed or cancelled" rather than
 * `status === 'completed'`: execution-finished events are not persisted, so a
 * reloaded turn has no status at all. Empty when there is nothing to report.
 */
export function documentWritesHistoryNote(state: AssistantStreamState | undefined): string {
  if (!state) return '';
  return state.toolCalls
    .filter(
      (tc) =>
        isDocumentContentTool(tc.name) &&
        tc.complete &&
        tc.status !== 'failed' &&
        tc.status !== 'cancelled',
    )
    .map((tc) => {
      if (isDocumentPatchTool(tc.name)) {
        const edits = Array.isArray(tc.arguments?.edits) ? tc.arguments.edits.length : 0;
        return `[Patched a document with patch_document (${edits} edit${edits === 1 ? '' : 's'}).]`;
      }
      const verb = tc.name.startsWith('edit_') ? 'Updated' : 'Wrote';
      const kind = KIND_BY_TOOL[tc.name] === 'html' ? 'HTML' : KIND_BY_TOOL[tc.name] === 'markdown' ? 'Markdown' : 'text';
      const title = typeof tc.arguments?.title === 'string' && tc.arguments.title.trim() ? ` "${tc.arguments.title.trim()}"` : '';
      return `[${verb} ${kind} document${title} with ${tc.name}.]`;
    })
    .join('\n');
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

/* Ids, not display words. These reach the UI through `documentKindLabel` and
 * an ICU `select`; a word here would be English in every locale. */
const KIND_BY_TOOL: Record<string, string> = {
  write_html_document: 'html',
  edit_html_document: 'html',
  write_markdown_document: 'markdown',
  edit_markdown_document: 'markdown',
  write_text_document: 'text',
  edit_text_document: 'text',
};

const ACTION_BY_TOOL: Record<string, string> = {
  write_html_document: 'create',
  edit_html_document: 'edit',
  write_markdown_document: 'create',
  edit_markdown_document: 'edit',
  write_text_document: 'create',
  edit_text_document: 'edit',
  patch_document: 'edit',
  read_document: 'read',
};

export interface DocumentToolSummary {
  /** `create` | `edit` | `document`. An id — translate before showing it. */
  action: string;
  /** `html` | `markdown` | `text` | `document`. An id, likewise. */
  kind: string;
  title?: string;
  filename?: string;
  lineCount: number;
  charCount: number;
}

/** Summarize a document tool call for compact display (no full content). */
export function summarizeDocumentToolCall(toolCall: ToolCallState): DocumentToolSummary | undefined {
  if (!DOCUMENT_TOOL_NAMES.has(toolCall.name)) return undefined;
  // Arguments are only parsed at `toolCallComplete`. Until then the streaming
  // scan is the one place the title and size are known.
  const live = toolCall.arguments === undefined ? toolCall.documentWrite : undefined;
  if (live) {
    return {
      action: ACTION_BY_TOOL[toolCall.name] ?? 'document',
      kind: KIND_BY_TOOL[toolCall.name] ?? 'document',
      title: live.title?.trim() || undefined,
      filename: live.filename?.trim() || undefined,
      lineCount: live.contentLines,
      charCount: live.contentChars,
    };
  }
  const args = toolCall.arguments ?? {};
  const contentField = CONTENT_FIELD_BY_TOOL[toolCall.name];
  // A patch's size is the text it puts in, not the whole document.
  const content = isDocumentPatchTool(toolCall.name)
    ? (Array.isArray(args.edits) ? args.edits : [])
        .map((edit) =>
          edit && typeof edit === 'object' && typeof (edit as { new_text?: unknown }).new_text === 'string'
            ? (edit as { new_text: string }).new_text
            : '',
        )
        .join('\n')
    : typeof args[contentField] === 'string'
      ? (args[contentField] as string)
      : '';
  const lineCount = content ? content.split('\n').length : 0;
  const charCount = content.length;
  const title = typeof args.title === 'string' ? args.title : undefined;
  const filename = typeof args.filename === 'string' ? args.filename : undefined;
  return {
    action: ACTION_BY_TOOL[toolCall.name] ?? 'document',
    kind: KIND_BY_TOOL[toolCall.name] ?? 'document',
    title,
    filename,
    lineCount,
    charCount,
  };
}

/// Artifact `kind` as it appears in backend error strings → display word.
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
export function explainToolError(error: string | undefined, fallback: string, t: Translate): string {
  if (!error) return fallback;
  const mismatch = KIND_MISMATCH.exec(error.trim());
  if (mismatch) {
    const actual = documentKindLabel(mismatch[1], t);
    const expected = documentKindLabel(mismatch[2], t);
    return t('chat.toolError.kindMismatch', { actual, expected });
  }
  return error;
}

/** Redact the large content field(s) from arguments for compact display. */
export function redactDocumentToolArguments(
  args: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  if (isDocumentPatchTool(toolName) && Array.isArray(args.edits)) {
    return { ...args, edits: `… ${args.edits.length}` };
  }
  const contentField = CONTENT_FIELD_BY_TOOL[toolName];
  if (!contentField) return args;
  const next: Record<string, unknown> = { ...args };
  if (contentField in next) {
    next[contentField] = '…';
  }
  return next;
}
