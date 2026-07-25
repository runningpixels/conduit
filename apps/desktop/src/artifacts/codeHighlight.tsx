/// Shared Prism-based syntax highlighting for chat inline blocks and artifact
/// code previews. Emits React nodes only (no dangerouslySetInnerHTML) per ADR-007.

import { Fragment, useMemo, type ReactNode } from 'react';
import { normalizeTokens, type Token } from 'prism-react-renderer';
import { CODE_LANG } from '../chat/messageSegments';
import { Prism } from './prismGlobal';
import './prismGrammars';

/** Map fence aliases to Prism grammar ids not covered by CODE_LANG alone. */
const PRISM_LANG_ALIASES: Record<string, string> = {
  shell: 'bash',
  zsh: 'bash',
  fish: 'bash',
  gql: 'graphql',
  htm: 'html',
  md: 'markdown',
  txt: 'text',
  plain: 'text',
  plaintext: 'text',
  patch: 'diff',
  dockerfile: 'docker',
  conf: 'ini',
};

export type HighlightTokens = Token[][];

/** Resolve a fence info string / mime hint to a Prism language id. */
export function normalizeCodeLanguage(raw?: string): string | undefined {
  if (!raw?.trim()) return undefined;
  const key = raw.trim().toLowerCase();
  const mapped = CODE_LANG[key] ?? key;
  return PRISM_LANG_ALIASES[mapped] ?? mapped;
}

function isLanguageSupported(language: string): boolean {
  return Boolean(Prism.languages[language]);
}

/** Tokenize code synchronously; returns null when unsupported or on failure. */
export function tokenizeHighlightedCode(code: string, language?: string): HighlightTokens | null {
  const normalized = normalizeCodeLanguage(language);
  if (!normalized || !isLanguageSupported(normalized)) return null;
  const grammar = Prism.languages[normalized];
  if (!grammar) return null;
  try {
    const raw = Prism.tokenize(code, grammar);
    return normalizeTokens(raw);
  } catch {
    return null;
  }
}

/** Memoized hook wrapper for React call sites. */
export function useHighlightTokens(code: string, language?: string): HighlightTokens | null {
  const normalized = normalizeCodeLanguage(language);
  return useMemo(
    () => (normalized ? tokenizeHighlightedCode(code, normalized) : null),
    [code, normalized],
  );
}

/** Render a single tokenized line as class-named spans (no inline theme styles). */
export function renderHighlightLine(tokens: Token[], keyPrefix: string): ReactNode {
  return tokens.map((token, idx) => (
    <span key={`${keyPrefix}-${idx}`} className={['token', ...token.types].join(' ')}>
      {token.content}
    </span>
  ));
}

/** Render all lines with newline separators between them. */
export function renderHighlightedCode(tokens: HighlightTokens): ReactNode {
  return tokens.map((line, lineIdx) => (
    <Fragment key={`line-${lineIdx}`}>
      {lineIdx > 0 ? '\n' : null}
      {renderHighlightLine(line, `l${lineIdx}`)}
    </Fragment>
  ));
}
