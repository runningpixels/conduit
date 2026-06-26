import type { ArtifactKind } from '../ipc/contracts';

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

const CODE_LANG: Record<string, string> = {
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
  gradle: 'gradle',
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

function matchOpenFence(line: string): { fence: string; info: string } | null {
  const m = /^(\s*)(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!m) return null;
  return { fence: m[2], info: m[3].trim() };
}

function isCloseFence(line: string, openChar: string): boolean {
  const m = /^(\s*)(`{3,}|~{3,})\s*$/.exec(line);
  if (!m) return false;
  return m[2][0] === openChar;
}

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
  if (body.length > MIN_UNLABELED_BODY) {
    return looksLikeJson(body) ? 'json' : 'markdown';
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
  // Generic first non-empty line (existing behavior)
  const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
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
    const open = matchOpenFence(lines[i]);
    if (!open) {
      proseLines.push(lines[i]);
      continue;
    }
    const openChar = open.fence[0];
    const bodyLines: string[] = [];
    const rawLines: string[] = [lines[i]];
    let j = i + 1;
    while (j < lines.length) {
      rawLines.push(lines[j]);
      if (isCloseFence(lines[j], openChar)) break;
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
