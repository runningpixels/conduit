/// Live preview of a section while the assistant is still writing it.
///
/// A `write_section` call's arguments arrive as streamed JSON fragments; the
/// section only lands in the draft when the call runs, after the response
/// ends. Until then the editor shows a preview document: the draft with each
/// section being written put where the backend will put it. The preview is
/// display only; it is never saved.

import type { AssistantStreamState } from '../chat/streamState';
import type { OutlineSection } from '../ipc/contracts';

export const WRITE_SECTION_TOOL = 'write_section';

/** The fields of a streaming `write_section` call read so far. */
export interface PartialWriteSection {
  heading: string | null;
  markdown: string | null;
}

/** One `write_section` call still being written. */
export interface SectionPreview {
  toolCallId: string;
  heading: string;
  markdown: string;
}

/** Where a previewed section sits in the preview document. */
export interface PreviewRange {
  toolCallId: string;
  from: number;
  to: number;
}

export interface DraftPreview {
  markdown: string;
  ranges: PreviewRange[];
}

const WS = new Set([' ', '\t', '\n', '\r']);

/**
 * Read a JSON string starting at `at` (just past its opening quote). Returns
 * the decoded text and the index after the closing quote, or `end: null`
 * when the input stops first. A cut escape (`\`, `\u12`) or a lone high
 * surrogate at the cut is dropped rather than shown half-decoded.
 */
function readString(text: string, at: number): { value: string; end: number | null } {
  let out = '';
  let i = at;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch !== '\\') {
      out += ch;
      i += 1;
      continue;
    }
    if (i + 1 >= text.length) break;
    const esc = text[i + 1];
    if (esc === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        // Not valid JSON; keep going rather than lose the rest.
        i += 2;
        continue;
      }
      out += String.fromCharCode(parseInt(hex, 16));
      i += 6;
      continue;
    }
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
    out += simple[esc] ?? esc;
    i += 2;
  }
  // Cut short: a high surrogate whose pair has not arrived is not text yet.
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return { value: out, end: null };
}

/** Skip a non-string JSON value (number, literal, object, array); null when cut. */
function skipValue(text: string, at: number): number | null {
  let i = at;
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const s = readString(text, i + 1);
      if (s.end == null) return null;
      i = s.end;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      if (depth === 0) return i;
      depth -= 1;
      if (depth === 0) return i + 1;
    } else if (ch === ',' && depth === 0) return i;
    i += 1;
  }
  return null;
}

/**
 * The `heading` and `markdown` of a `write_section` call from its arguments
 * so far. Tolerant of a cut anywhere: a string value cut mid-way gives the
 * text up to the cut; a key not reached yet stays null.
 */
export function parsePartialWriteSection(argumentsText: string): PartialWriteSection {
  const out: PartialWriteSection = { heading: null, markdown: null };
  const text = argumentsText;
  let i = 0;
  const skipWs = () => {
    while (i < text.length && WS.has(text[i])) i += 1;
  };
  skipWs();
  if (text[i] !== '{') return out;
  i += 1;
  for (;;) {
    skipWs();
    if (i >= text.length || text[i] === '}') return out;
    if (text[i] === ',') {
      i += 1;
      continue;
    }
    if (text[i] !== '"') return out;
    const key = readString(text, i + 1);
    if (key.end == null) return out;
    i = key.end;
    skipWs();
    if (text[i] !== ':') return out;
    i += 1;
    skipWs();
    if (i >= text.length) return out;
    if (text[i] === '"') {
      const value = readString(text, i + 1);
      if (key.value === 'heading') out.heading = value.value;
      else if (key.value === 'markdown') out.markdown = value.value;
      if (value.end == null) return out;
      i = value.end;
    } else {
      const end = skipValue(text, i);
      if (end == null) return out;
      i = end;
    }
  }
}

function isFinished(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

/** The `write_section` calls of a streaming turn that have not run yet, in order. */
export function sectionPreviewsFromStream(state: AssistantStreamState | null | undefined): SectionPreview[] {
  if (!state || !state.streaming) return [];
  const out: SectionPreview[] = [];
  for (const call of state.toolCalls) {
    if (call.name !== WRITE_SECTION_TOOL || isFinished(call.status)) continue;
    const parsed =
      call.arguments && typeof call.arguments.heading === 'string'
        ? {
            heading: call.arguments.heading,
            markdown: typeof call.arguments.markdown === 'string' ? call.arguments.markdown : '',
          }
        : parsePartialWriteSection(call.argumentsText);
    const heading = parsed.heading?.trim();
    if (!heading) continue;
    out.push({ toolCallId: call.toolCallId, heading, markdown: parsed.markdown ?? '' });
  }
  return out;
}

// --- Placement: mirrors `draft_blocks::write_section` ----------------------

/** A heading's text without its markers, whitespace collapsed, lowercased. */
export function headingKey(text: string): string {
  const first = text.split('\n')[0] ?? '';
  return first
    .trim()
    .replace(/^#+/, '')
    .replace(/#+$/, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

interface HeadingLine {
  start: number;
  /** End of the line's text (before its line break). */
  end: number;
  level: number;
  text: string;
}

/** ATX headings outside fenced code and front matter, in order. */
function headings(md: string): HeadingLine[] {
  const out: HeadingLine[] = [];
  let fence: string | null = null;
  let at = 0;
  let lineNo = 0;
  let inFrontMatter = false;
  while (at <= md.length) {
    const nl = md.indexOf('\n', at);
    const lineEnd = nl === -1 ? md.length : nl;
    const line = md.slice(at, lineEnd).replace(/\r$/, '');
    if (lineNo === 0 && line === '---') inFrontMatter = true;
    else if (inFrontMatter) {
      if (line === '---' || line === '...') inFrontMatter = false;
    } else {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence != null) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      } else if (fenceMatch) {
        fence = fenceMatch[1];
      } else {
        const h = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(line);
        if (h) out.push({ start: at, end: at + line.length, level: h[1].length, text: line });
      }
    }
    if (nl === -1) break;
    at = nl + 1;
    lineNo += 1;
  }
  return out;
}

/** The section a heading names: [start, end) with trailing blank lines left out. */
function sectionRange(md: string, list: HeadingLine[], key: string): { start: number; end: number; line: string } | null {
  const first = list.findIndex((h) => h.level <= 2 && headingKey(h.text) === key);
  if (first === -1) return null;
  const head = list[first];
  const next = list.slice(first + 1).find((h) => h.level <= head.level);
  let end = next ? next.start : md.length;
  while (end > head.start && /\s/.test(md[end - 1])) end -= 1;
  return { start: head.start, end: Math.max(end, head.end), line: head.text.trim() };
}

/** The section's text as `write_section` will write it (heading line added when missing). */
function sectionText(body: string, headingLine: string): string {
  const clean = body.replace(/^[\r\n]+/, '').trimEnd();
  // "#" or "##" so far: its heading line is still arriving.
  if (clean === '#' || clean === '##') return headingLine;
  if (/^#{1,6}(?:[ \t]|$)/.test(clean)) return clean;
  return clean === '' ? headingLine : `${headingLine}\n\n${clean}`;
}

/** One section written into `md`; the changed span of the result. */
function placeSection(
  md: string,
  outline: readonly string[],
  preview: SectionPreview,
): { markdown: string; changeFrom: number; changeTo: number; insertedLength: number; from: number; to: number } {
  const list = headings(md);
  const key = headingKey(preview.heading);
  const existing = sectionRange(md, list, key);
  const outlineHeading = outline.find((h) => headingKey(h) === key);
  const headingLine = existing
    ? existing.line
    : `## ${(outlineHeading ?? preview.heading).trim()}`;
  const section = sectionText(preview.markdown, headingLine);
  if (existing) {
    return {
      markdown: md.slice(0, existing.start) + section + md.slice(existing.end),
      changeFrom: existing.start,
      changeTo: existing.end,
      insertedLength: section.length,
      from: existing.start,
      to: existing.start + section.length,
    };
  }
  const position = (k: string) => outline.findIndex((h) => headingKey(h) === k);
  const at = position(key);
  if (at !== -1) {
    const before = list.find((h) => h.level === 2 && position(headingKey(h.text)) > at);
    if (before) {
      const inserted = `${section}\n\n`;
      return {
        markdown: md.slice(0, before.start) + inserted + md.slice(before.start),
        changeFrom: before.start,
        changeTo: before.start,
        insertedLength: inserted.length,
        from: before.start,
        to: before.start + section.length,
      };
    }
  }
  if (md.trim() === '') {
    return {
      markdown: `${section}\n`,
      changeFrom: 0,
      changeTo: md.length,
      insertedLength: section.length + 1,
      from: 0,
      to: section.length,
    };
  }
  const kept = md.trimEnd();
  const from = kept.length + 2;
  return {
    markdown: `${kept}\n\n${section}\n`,
    changeFrom: kept.length,
    changeTo: md.length,
    insertedLength: section.length + 3,
    from,
    to: from + section.length,
  };
}

/**
 * The draft as it will read once the sections being written land: each
 * preview in order, replacing its section when the heading exists (case and
 * spacing ignored), else before the first later outline section in the
 * draft, else at the end. Null when there is nothing to preview.
 */
export function buildDraftPreview(
  markdown: string,
  outline: readonly OutlineSection[],
  previews: readonly SectionPreview[],
): DraftPreview | null {
  if (previews.length === 0) return null;
  const headingsInOutline = outline.map((s) => s.heading);
  let md = markdown;
  let ranges: PreviewRange[] = [];
  for (const preview of previews) {
    const placed = placeSection(md, headingsInOutline, preview);
    const delta = placed.insertedLength - (placed.changeTo - placed.changeFrom);
    ranges = ranges
      // A later call rewriting the same span replaces the earlier preview.
      .filter((r) => r.to <= placed.changeFrom || r.from >= placed.changeTo)
      .map((r) => (r.from >= placed.changeTo ? { ...r, from: r.from + delta, to: r.to + delta } : r));
    ranges.push({ toolCallId: preview.toolCallId, from: placed.from, to: placed.to });
    md = placed.markdown;
  }
  return { markdown: md, ranges };
}
