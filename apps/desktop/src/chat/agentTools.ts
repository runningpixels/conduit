import type { ToolDefinition } from '@conduit/config-schema';
import type { Artifact } from '../ipc/contracts';
import type { AssistantStreamState, ToolCallState } from './streamState';
import type { DocumentTurnIntent } from './documentTurnIntent';

const DOCUMENT_TOOL_GROUP = 'Documents';

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

export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    toolId: 'write_html_document',
    name: 'write_html_document',
    description:
      'Create a new HTML document artifact. Use only when the user explicitly asked to create HTML content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — Conduit assigns IDs.',
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
      'Create a new Markdown document artifact. Use only when the user explicitly asked to create Markdown content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — Conduit assigns IDs.',
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
      'Create a new plain-text document artifact. Use only when the user explicitly asked to create plain-text content. Do not use to answer capability or explanatory questions. Omit artifact_id for new documents — Conduit assigns IDs.',
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
  // ---------------------------------------------------------------------------
  // Web tools (search-gated)
  // ---------------------------------------------------------------------------
  {
    toolId: 'web_search',
    name: 'web_search',
    description: 'Search the web for information. Provide a `query` string. Returns up to 10 results with titles, snippets, and URLs.',
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
];

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
  BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.displayGroup === DOCUMENT_TOOL_GROUP).map(
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

const UTILITY_TOOL_NAMES = new Set(['current_time', 'uuid', 'random', 'calculator']);
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch']);
const CLIPBOARD_TOOL_NAMES = new Set(['clipboard_read', 'clipboard_write']);

/** Built-in document tools exposed to the model for a given turn intent. */
export function selectBuiltinDocumentTools(intent: DocumentTurnIntent): ToolDefinition[] {
  const utilityTools = BUILTIN_TOOL_DEFINITIONS.filter((t) => UTILITY_TOOL_NAMES.has(t.name));
  switch (intent) {
    case 'create':
      return [
        ...utilityTools,
        ...BUILTIN_TOOL_DEFINITIONS.filter(
          (tool) => tool.name.startsWith('write_') || tool.name === 'export_document',
        ),
      ];
    case 'edit':
      return [
        ...utilityTools,
        ...BUILTIN_TOOL_DEFINITIONS.filter(
          (tool) => tool.name.startsWith('edit_') || tool.name === 'export_document',
        ),
      ];
    case 'info':
    case 'general':
    default:
      return utilityTools;
  }
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
