/// Fence info-string helpers shared by chat (`ChatProse`) and markdown
/// (`safeMarkdown`). The info string is the text after the opening backticks.

export function fenceLang(info: string): string {
  return info.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

export function isMermaidLang(lang: string): boolean {
  return lang === 'mermaid';
}

export function isMathLang(lang: string): boolean {
  return lang === 'math' || lang === 'latex' || lang === 'tex';
}

export function isMarkdownLang(lang: string): boolean {
  return lang === 'markdown' || lang === 'md';
}

/// First-line keywords mermaid uses to pick a diagram type. Used to recognise
/// a diagram that arrived without a `mermaid` info string — models asked to
/// "reply with only this markdown" wrap the fence in ```markdown, or drop the
/// language tag entirely, and the first body line is then `flowchart TD`.
const MERMAID_DIAGRAM_START =
  /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|sankey-beta|xychart-beta|block-beta|packet-beta|kanban|architecture-beta|C4(?:Context|Container|Component|Dynamic|Deployment))\b/;

export function looksLikeMermaidSource(source: string): boolean {
  const first = source
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return first != null && MERMAID_DIAGRAM_START.test(first);
}

/**
 * If `source` is exactly one fenced block (optional surrounding whitespace),
 * return that fence's info string and body. Extra prose after the close means
 * this is a document, not a wrapped diagram.
 * Also accepts an *unclosed* inner fence. CommonMark lets a nested ``` close
 * a ```markdown wrapper, so the stored body is often ` ```mermaid\nflowchart TD`
 * with no closer — the closer was consumed by the parent.
 */
export function unwrapSoleFence(source: string): { info: string; body: string } | null {
  const src = source.replace(/\r\n?/g, '\n').trim();
  if (!src) return null;
  const lines = src.split('\n');
  const open = matchFenceOpen(lines[0]);
  if (!open) return null;
  let closeAt = -1;
  for (let i = 1; i < lines.length; i++) {
    if (isFenceClose(lines[i], open.fence)) {
      closeAt = i;
      break;
    }
  }
  if (closeAt === -1) {
    return { info: open.info, body: lines.slice(1).join('\n') };
  }
  const rest = lines.slice(closeAt + 1).join('\n').trim();
  if (rest) return null;
  return { info: open.info, body: lines.slice(1, closeAt).join('\n') };
}

/**
 * The mermaid source to draw for this fence, or null if it is not a diagram.
 *
 * Handles the labeled fence, a markdown/text wrapper whose sole payload is a
 * ```mermaid fence (including when CommonMark stole the inner closer), and a
 * wrapper whose body *is* the diagram source (`flowchart TD` as the first line).
 *
 * Unlabeled fences are left alone unless the body itself is diagram source —
 * a ```` quote of a mermaid example must stay source, not a rendered diagram.
 */
export function mermaidSourceFromFence(info: string, body: string): string | null {
  const lang = fenceLang(info);
  if (isMermaidLang(lang)) return body;

  if (isMarkdownLang(lang) || lang === 'text') {
    const inner = unwrapSoleFence(body);
    if (inner) {
      const innerLang = fenceLang(inner.info);
      if (isMermaidLang(innerLang) || looksLikeMermaidSource(inner.body)) return inner.body;
      return null;
    }
    if (looksLikeMermaidSource(body)) return body;
    return null;
  }

  if (lang === '' && looksLikeMermaidSource(body)) return body;
  return null;
}

/// The delimiter run that opens a fence, plus its info string.
export interface FenceOpen {
  /// The run itself — `` ``` ``, `` ```` ``, `~~~`. Its length is what a
  /// closing run has to match.
  fence: string;
  info: string;
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

/// The opening run and info string of `line`, or null if it opens no fence.
export function matchFenceOpen(line: string): FenceOpen | null {
  const m = FENCE_OPEN.exec(line);
  if (!m) return null;
  return { fence: m[1], info: m[2].trim() };
}

/// Any line that carries a fence delimiter, opening or closing.
export function isFenceLine(line: string): boolean {
  return FENCE_OPEN.test(line);
}

/**
 * Whether `line` closes a fence opened with the run `open`.
 *
 * CommonMark: the closing run uses the same character, is *at least as long*
 * as the opener, and carries nothing else. The length rule is the load-bearing
 * half — comparing only the character closed a ```` block on the first ```
 * nested inside it, so a fence quoting another fence was torn in two and the
 * remainder of the message parsed as if it were the fence's tail.
 */
export function isFenceClose(line: string, open: string): boolean {
  const m = FENCE_CLOSE.exec(line);
  if (!m) return false;
  return m[1][0] === open[0] && m[1].length >= open.length;
}
