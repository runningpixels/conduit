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
];

export const DOCUMENT_TOOL_NAMES = new Set(BUILTIN_TOOL_DEFINITIONS.map((tool) => tool.name));

/** Document tools that create or edit content (excludes export). */
export const DOCUMENT_CONTENT_TOOL_NAMES = new Set(
  BUILTIN_TOOL_DEFINITIONS.filter((tool) => tool.name !== 'export_document').map((tool) => tool.name),
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

/** Built-in document tools exposed to the model for a given turn intent. */
export function selectBuiltinDocumentTools(intent: DocumentTurnIntent): ToolDefinition[] {
  switch (intent) {
    case 'create':
      return BUILTIN_TOOL_DEFINITIONS.filter(
        (tool) => tool.name.startsWith('write_') || tool.name === 'export_document',
      );
    case 'edit':
      return BUILTIN_TOOL_DEFINITIONS.filter(
        (tool) => tool.name.startsWith('edit_') || tool.name === 'export_document',
      );
    case 'info':
    case 'general':
    default:
      return [];
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
