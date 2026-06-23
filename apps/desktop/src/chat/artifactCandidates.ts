/// M2 — artifact candidate detection over finalized assistant content.
///
/// Pure, no React, no IPC. Scans a message's text for fenced code blocks
/// (``` or ~~~) and decides which are worth offering as "Promote to artifact".
///
/// Rules (plan §3):
/// - A fence with an info string that maps to an `ArtifactKind` is always a
///   candidate (any size): `markdown`/`md` → markdown, `json` → json,
///   `html`/`htm` → html, `text`/`txt`/`plain` → text, anything else → code.
/// - A fence with NO info string is a candidate only when the body is long
///   (> 200 chars); it is offered as markdown (or json if it parses as JSON).
/// - Small unlabeled blocks are not candidates (they are usually inline
///   snippets, not documents).
///
/// The detection is intentionally line-based and tolerant: an unclosed fence
/// at EOF is treated as a candidate whose body runs to the end. We never
/// execute or parse the body as HTML — `body` is opaque text handed to the
/// safe renderers.

import type { ArtifactKind } from '../ipc/contracts';

export interface ArtifactCandidate {
  /// Stable key within the message (the 0-based line index of the opening
  /// fence). Used to hide the affordance after promotion in component state.
  key: string;
  /// The fence info string (language), trimmed. May be empty.
  info: string;
  /// Raw body between the fences (no surrounding backticks), with original
  /// newlines preserved.
  body: string;
  /// Resolved artifact kind for `createArtifact`.
  kind: ArtifactKind;
  /// Suggested title for `createArtifact`.
  title: string;
  /// Suggested MIME type for `setArtifactContent` (drives renderer selection
  /// + the code language chip via `text/x-<lang>`).
  mimeType: string;
}

/// Info-string token → artifact kind. Anything not listed maps to `code`.
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

/// Recognized code languages → normalized chip label (the `text/x-<lang>` MIME
/// carries this to the CodeRenderer). Keys are lowercased info strings.
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
  code: 'text/plain', // overridden per-candidate with text/x-<lang>
};

const MIN_UNLABELED_BODY = 200;
const TITLE_MAX = 60;

/// A line that opens a fence: optional leading whitespace, then 3+ backticks
/// or 3+ tildes, then the rest of the line as the info string.
function matchOpenFence(line: string): { fence: string; info: string } | null {
  const m = /^(\s*)(`{3,}|~{3,})([^\n]*)$/.exec(line);
  if (!m) return null;
  return { fence: m[2], info: m[3].trim() };
}

/// A line that closes a fence: only the fence char (same family as the
/// opener) plus optional trailing whitespace, no info string.
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

/// Resolve the candidate kind for a fence. Returns `null` when the block is
/// not promotable (small unlabeled snippet).
function resolveKind(info: string, body: string): ArtifactKind | null {
  const lang = firstInfoToken(info).toLowerCase();
  if (lang) {
    const mapped = KIND_FROM_LANG[lang];
    if (mapped) return mapped;
    // Any other labeled fence → code. (Unknown labels are still code blocks.)
    return 'code';
  }
  // No info string: only promote long unlabeled blocks.
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

function deriveTitle(kind: ArtifactKind, info: string, body: string): string {
  // First non-empty line of the body, trimmed + truncated.
  const firstLine = body.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) {
    return firstLine.length > TITLE_MAX ? `${firstLine.slice(0, TITLE_MAX)}…` : firstLine;
  }
  const lang = firstInfoToken(info);
  if (lang) return `${lang} snippet`;
  return kind === 'markdown' ? 'Markdown artifact' : 'Text artifact';
}

/// Detect promotable artifact candidates in finalized assistant content.
/// Empty/streaming content yields no candidates.
export function detectArtifactCandidates(content: string): ArtifactCandidate[] {
  if (!content) return [];
  const src = content.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const out: ArtifactCandidate[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = matchOpenFence(lines[i]);
    if (!open) continue;
    const openChar = open.fence[0];
    const bodyLines: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      if (isCloseFence(lines[j], openChar)) break;
      bodyLines.push(lines[j]);
      j++;
    }
    // j is either the close-fence line or lines.length (unclosed at EOF —
    // treat the rest as the body).
    const body = bodyLines.join('\n');
    if (!body.trim()) {
      i = j; // empty body — not a candidate
      continue;
    }
    const kind = resolveKind(open.info, body);
    if (!kind) {
      i = j; // skip past this fence (and its body) regardless
      continue;
    }
    out.push({
      key: `cand-${i}`,
      info: open.info,
      body,
      kind,
      title: deriveTitle(kind, open.info, body),
      mimeType: deriveMime(kind, open.info),
    });
    i = j;
  }
  return out;
}