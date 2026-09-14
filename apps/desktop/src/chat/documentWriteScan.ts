import type { AssistantStreamState } from './streamState';
import type { Translate } from '../i18n';
import type { Formatters } from '../i18n/formatters';

/**
 * Live progress for a document tool call whose arguments are still streaming.
 *
 * A `write_html_document` call carries the whole document as one JSON string
 * argument, so for tens of seconds the only thing arriving is `toolCallDelta`
 * fragments of that JSON. Nothing rendered them, and the turn read as stuck
 * until the finished artifact appeared. This scanner reads the fragments as
 * they arrive — once each, never re-parsing the accumulated text — and keeps
 * just enough to say what is being written and how far along it is: the
 * top-level `title`/`filename` strings and a character/line count for the
 * content field. The content itself is never kept.
 */

/** The argument that carries the document body, per content tool. */
export const CONTENT_FIELD_BY_TOOL: Record<string, string> = {
  write_html_document: 'html',
  edit_html_document: 'updated_html',
  write_markdown_document: 'markdown',
  edit_markdown_document: 'updated_markdown',
  write_text_document: 'text',
  edit_text_document: 'updated_text',
};

/** How long a write may go without a fragment before the UI says it is still working. */
export const DOCUMENT_WRITE_STALL_MS = 15_000;

/** Longest `title`/`filename` kept — a label, not a payload. */
const MAX_LABEL_CHARS = 200;
/** Longest top-level key tracked; real keys are short, anything longer is not one we want. */
const MAX_KEY_CHARS = 64;

export interface DocumentWriteScan {
  contentField: string;
  title?: string;
  filename?: string;
  /** Decoded characters of the content field received so far. */
  contentChars: number;
  /** Lines in the content received so far; 0 until the content string opens. */
  contentLines: number;
  // Scanner state — resumes exactly where the previous fragment ended.
  depth: number;
  inString: boolean;
  /** Top-level key being read, or the last one completed. */
  key: string;
  expectKey: boolean;
  role: 'key' | 'value' | 'other';
  escaped: boolean;
  /** Hex digits still owed by a `\uXXXX` escape, and those seen so far. */
  unicodeRemaining: number;
  unicodeHex: string;
}

export function startDocumentWriteScan(toolName: string): DocumentWriteScan | undefined {
  const contentField = CONTENT_FIELD_BY_TOOL[toolName];
  if (!contentField) return undefined;
  return {
    contentField,
    contentChars: 0,
    contentLines: 0,
    depth: 0,
    inString: false,
    key: '',
    expectKey: false,
    role: 'other',
    escaped: false,
    unicodeRemaining: 0,
    unicodeHex: '',
  };
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
};

/** Feed one argument fragment into the scan. Pure: returns a new scan. */
export function advanceDocumentWriteScan(scan: DocumentWriteScan, chunk: string): DocumentWriteScan {
  const s: DocumentWriteScan = { ...scan };

  const emit = (ch: string) => {
    if (s.role === 'key') {
      if (s.key.length < MAX_KEY_CHARS) s.key += ch;
      return;
    }
    if (s.role !== 'value') return;
    if (s.key === s.contentField) {
      s.contentChars += 1;
      if (ch === '\n') s.contentLines += 1;
    } else if (s.key === 'title' || s.key === 'filename') {
      const current = s[s.key] ?? '';
      if (current.length < MAX_LABEL_CHARS) s[s.key] = current + ch;
    }
  };

  for (const ch of chunk) {
    if (s.inString) {
      if (s.unicodeRemaining > 0) {
        s.unicodeHex += ch;
        s.unicodeRemaining -= 1;
        if (s.unicodeRemaining === 0) {
          const code = Number.parseInt(s.unicodeHex, 16);
          emit(Number.isNaN(code) ? String.fromCharCode(0xfffd) : String.fromCharCode(code));
          s.unicodeHex = '';
        }
      } else if (s.escaped) {
        s.escaped = false;
        if (ch === 'u') {
          s.unicodeRemaining = 4;
          s.unicodeHex = '';
        } else {
          emit(SIMPLE_ESCAPES[ch] ?? ch);
        }
      } else if (ch === '\\') {
        s.escaped = true;
      } else if (ch === '"') {
        s.inString = false;
        if (s.role === 'key') s.expectKey = false;
      } else {
        emit(ch);
      }
      continue;
    }

    switch (ch) {
      case '"':
        s.inString = true;
        if (s.depth === 1 && s.expectKey) {
          s.role = 'key';
          s.key = '';
        } else if (s.depth === 1) {
          s.role = 'value';
          if (s.key === s.contentField && s.contentLines === 0) s.contentLines = 1;
          if (s.key === 'title' || s.key === 'filename') s[s.key] = '';
        } else {
          s.role = 'other';
        }
        break;
      case '{':
      case '[':
        s.depth += 1;
        if (s.depth === 1) s.expectKey = true;
        break;
      case '}':
      case ']':
        s.depth = Math.max(0, s.depth - 1);
        break;
      case ',':
        if (s.depth === 1) s.expectKey = true;
        break;
      default:
        break;
    }
  }
  return s;
}

export interface ActiveDocumentWrite {
  toolCallId: string;
  toolName: string;
  /** `html` | `markdown` | `text` — an id, translate before showing it. */
  kind: string;
  mode: 'create' | 'edit';
  title?: string;
  filename?: string;
  contentChars: number;
  contentLines: number;
  startedAt: number;
  /** Last time a fragment arrived (or the call started, before any did). */
  lastActivityAt: number;
}

function kindForTool(toolName: string): string {
  if (toolName.includes('html')) return 'html';
  if (toolName.includes('markdown')) return 'markdown';
  return 'text';
}

/**
 * The document the model is writing right now, if any: the latest content
 * tool call whose arguments are still streaming. `undefined` once the call is
 * complete (the tool is then executing, which the existing phases describe) or
 * the turn has stopped streaming.
 */
export function activeDocumentWrite(state: AssistantStreamState | null): ActiveDocumentWrite | undefined {
  if (!state?.streaming) return undefined;
  for (let i = state.toolCalls.length - 1; i >= 0; i -= 1) {
    const tc = state.toolCalls[i];
    if (!tc.documentWrite || tc.complete || tc.status) continue;
    const startedAt = tc.startedAt ?? Date.now();
    return {
      toolCallId: tc.toolCallId,
      toolName: tc.name,
      kind: kindForTool(tc.name),
      mode: tc.name.startsWith('write_') ? 'create' : 'edit',
      title: tc.documentWrite.title?.trim() || undefined,
      filename: tc.documentWrite.filename?.trim() || undefined,
      contentChars: tc.documentWrite.contentChars,
      contentLines: tc.documentWrite.contentLines,
      startedAt,
      lastActivityAt: tc.lastDeltaAt ?? startedAt,
    };
  }
  return undefined;
}

/** "Writing “Q3 report”…" / "Writing HTML document…" / "Updating HTML document…". */
export function documentWriteLabel(write: ActiveDocumentWrite, t: Translate): string {
  const name = write.title ?? write.filename;
  if (write.mode === 'create' && name) {
    return t('chat.documentWrite.writingTitled', { title: name });
  }
  return write.mode === 'edit'
    ? t('chat.documentWrite.updatingKind', { kind: write.kind })
    : t('chat.documentWrite.writingKind', { kind: write.kind });
}

/** "214 lines · 18 KB", or `undefined` before any content has arrived. */
export function documentWriteDetail(
  write: Pick<ActiveDocumentWrite, 'contentChars' | 'contentLines'>,
  t: Translate,
  fmt: Formatters,
): string | undefined {
  if (write.contentChars === 0) return undefined;
  return t('chat.documentWrite.progress', {
    lines: write.contentLines,
    size: fmt.size(write.contentChars),
  });
}

/** True once a write has gone `DOCUMENT_WRITE_STALL_MS` without a fragment. */
export function documentWriteStalled(lastActivityAt: number | undefined, now: number): boolean {
  return lastActivityAt !== undefined && now - lastActivityAt >= DOCUMENT_WRITE_STALL_MS;
}