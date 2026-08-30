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
