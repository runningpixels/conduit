import type { ArtifactKind } from '../ipc/contracts';
import { isFenceClose, isFenceLine, matchFenceOpen } from '../artifacts/markdown/fenceLang';

export interface ArtifactCandidate {
  key: string;
  info: string;
  body: string;
  kind: ArtifactKind;
  title: string;
  mimeType: string;
}

const KIND_FROM_LANG: Record<string, ArtifactKind> = {
  markdown: 'markdown',
  md: 'markdown',
  text: 'text',
  txt: 'text',
  plain: 'text',
  plaintext: 'text',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
};

export const CODE_LANG: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  rs: 'rust',
  rust: 'rust',
  py: 'python',
  python: 'python',
  go: 'go',
  golang: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  csharp: 'csharp',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  sh: 'shell',
  bash: 'bash',
  shell: 'shell',
  zsh: 'zsh',
  fish: 'fish',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  lua: 'lua',
  kt: 'kotlin',
  kotlin: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  dart: 'dart',
  elixir: 'elixir',
  ex: 'elixir',
  exs: 'elixir',
  haskell: 'haskell',
  hs: 'haskell',
  clj: 'clojure',
  clojure: 'clojure',
  cljs: 'clojurescript',
  r: 'r',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gradle: 'groovy',
  ps1: 'powershell',
  powershell: 'powershell',
  pwsh: 'powershell',
  graphql: 'graphql',
  gql: 'graphql',
  ini: 'ini',
  conf: 'ini',
  diff: 'diff',
  patch: 'diff',
};

const KIND_MIME: Record<ArtifactKind, string> = {
  markdown: 'text/markdown',
  text: 'text/plain',
  json: 'application/json',
  html: 'text/html',
  code: 'text/plain',
};

const MIN_UNLABELED_BODY = 200;
const TITLE_MAX = 60;
const PREVIEW_MAX_CHARS = 120;

const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: 'Markdown',
  text: 'Text',
  code: 'Code',
  json: 'JSON',
  html: 'HTML',
};

function firstInfoToken(info: string): string {
  return info.split(/\s+/)[0] ?? '';
}

function looksLikeJson(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === '{' || first === '[') && (last === '}' || last === ']'))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function resolveKind(info: string, body: string): ArtifactKind | null {
  const lang = firstInfoToken(info).toLowerCase();
  if (lang) {
    const mapped = KIND_FROM_LANG[lang];
    if (mapped) return mapped;
    return 'code';
  }
  // Unlabeled fence. Sniff for structured artifacts (HTML / JSON) regardless of
  // size so a short unlabeled `<div>hi</div>` is still detected as a candidate
  // (previously it was dropped by the size gate, which made the "No artifact
  // content detected" warning fire even when the reply contained a fence). Keep
  // the size gate for the generic markdown fallback so incidental tiny
  // code/prose blocks (e.g. `let x=1`) are not promoted into artifacts.
  if (body.trim()) {
    if (looksLikeJson(body)) return 'json';
    if (/^\s*<(!doctype|html|[a-z][\w:-]*\b)/i.test(body)) return 'html';
    if (body.length > MIN_UNLABELED_BODY) return 'markdown';
  }
  return null;
}

function deriveMime(kind: ArtifactKind, info: string): string {
  if (kind === 'code') {
    const lang = firstInfoToken(info).toLowerCase();
    const normalized = CODE_LANG[lang] ?? (lang || undefined);
    return normalized ? `text/x-${normalized}` : 'text/plain';
  }
  return KIND_MIME[kind];
}

function extractHtmlTitle(body: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body);
  if (!m) return null;
  const t = m[1].replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

function extractMarkdownHeading(body: string): string | null {
  const m = /^#{1,6}\s+(.+)$/m.exec(body);
  if (!m) return null;
  const t = m[1].trim();
  if (!t) return null;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

function deriveTitle(kind: ArtifactKind, info: string, body: string): string {
  // Prefer explicit <title> for HTML artifacts
  if (kind === 'html') {
    const t = extractHtmlTitle(body);
    if (t) return t;
  }
  // Prefer first heading for markdown
  if (kind === 'markdown') {
    const t = extractMarkdownHeading(body);
    if (t) return t;
  }
  // Generic first non-empty line (existing behavior), skipping any fence
  // delimiter nested inside the body. A model that wraps its whole reply in a
  // ```markdown fence leaves ```mermaid as the first line, which titled the
  // card with punctuation instead of with anything a reader could act on.
  const firstLine = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !isFenceLine(l));
  if (firstLine) {
    return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX)}…` : firstLine;
  }
  const lang = firstInfoToken(info);
  if (lang) return `${lang} snippet`;
  return kind === 'markdown' ? 'Markdown artifact' : 'Text artifact';
}

export type MessageSegment =
  | { type: 'prose'; text: string }
  | { type: 'fence'; candidate: ArtifactCandidate; raw: string };

export function parseMessageSegments(content: string): MessageSegment[] {
  if (!content) return [];
  const src = content.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const segments: MessageSegment[] = [];
  let proseLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = matchFenceOpen(lines[i]);
    if (!open) {
      proseLines.push(lines[i]);
      continue;
    }
    const bodyLines: string[] = [];
    const rawLines: string[] = [lines[i]];
    let j = i + 1;
    while (j < lines.length) {
      rawLines.push(lines[j]);
      if (isFenceClose(lines[j], open.fence)) break;
      bodyLines.push(lines[j]);
      j++;
    }
    const body = bodyLines.join('\n');
    const raw = rawLines.join('\n');
    const kind = resolveKind(open.info, body);
    if (!body.trim() || !kind) {
      proseLines.push(lines[i]);
      for (let k = i + 1; k <= j && k < lines.length; k++) {
        proseLines.push(lines[k]);
      }
      i = j;
      continue;
    }
    if (proseLines.length > 0) {
      segments.push({ type: 'prose', text: proseLines.join('\n') });
      proseLines = [];
    }
    const candidate: ArtifactCandidate = {
      key: `cand-${i}`,
      info: open.info,
      body,
      kind,
      title: deriveTitle(kind, open.info, body),
      mimeType: deriveMime(kind, open.info),
    };
    segments.push({ type: 'fence', candidate, raw });
    i = j;
  }
  if (proseLines.length > 0) {
    segments.push({ type: 'prose', text: proseLines.join('\n') });
  }
  return segments;
}

function normalizePreviewWhitespace(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(' ');
}

function truncatePreview(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

/** One-line summary for a fenced artifact block (matches in-chat fence labels). */
export function summarizeFenceForPreview(candidate: ArtifactCandidate): string {
  const label = KIND_LABEL[candidate.kind] ?? candidate.kind;
  const lineCount = candidate.body.split('\n').length;
  const title = candidate.title.trim();
  const genericTitle =
    title === 'Markdown artifact' ||
    title === 'Text artifact' ||
    title.endsWith(' snippet');
  if (title && !genericTitle) {
    return `${label} artifact · ${title} · ${lineCount} lines`;
  }
  return `${label} artifact · ${lineCount} lines`;
}

/**
 * Produce a compact, artifact-aware preview for history rails and other
 * compact surfaces. Replaces fenced artifact bodies with one-line summaries.
 */
export function summarizeMessageContentForPreview(
  content: string,
  maxChars = PREVIEW_MAX_CHARS,
): string | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const segments = parseMessageSegments(trimmed);
  const parts: string[] = [];
  for (const seg of segments) {
    if (seg.type === 'prose') {
      const prose = normalizePreviewWhitespace(seg.text);
      if (prose) parts.push(prose);
    } else {
      parts.push(summarizeFenceForPreview(seg.candidate));
    }
  }

  const joined = normalizePreviewWhitespace(parts.join(' '));
  if (!joined) return null;
  return truncatePreview(joined, maxChars);
}
