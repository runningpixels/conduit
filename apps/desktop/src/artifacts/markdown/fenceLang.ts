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
