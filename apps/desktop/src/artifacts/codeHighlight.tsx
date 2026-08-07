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
  // `txt`/`plain`/`plaintext` deliberately absent: they used to map to `text`,
  // a Prism alias for an empty grammar. Plain text has no lexical categories to
  // colour, so it should fall through unsupported and take `--code` instead.
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

/** Whether Prism has a grammar that will actually produce tokens.
 *
 *  `Boolean(Prism.languages[x])` alone is not enough. prism-react-renderer
 *  registers `plain`/`plaintext`/`text`/`txt` as aliases of one shared **empty
 *  object**, which is truthy — so tokenising a ```text fence "succeeded",
 *  returned a single `plain` token per line, and callers concluded the content
 *  was highlighted. That left plain text rendering as dim `--ink-2` prose
 *  instead of taking `--code`, which is the opposite of the intent. An empty
 *  grammar has no rules, so it is not support. */
function isLanguageSupported(language: string): boolean {
  const grammar = Prism.languages[language] as Record<string, unknown> | undefined;
  return Boolean(grammar) && Object.keys(grammar as Record<string, unknown>).length > 0;
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

/** Render a single tokenized line as class-named spans (no inline theme styles).
 *
 *  The `token` base class is required: every rule in `syntax.css` is qualified
 *  as `.token.keyword`, `.token.string` and so on, matching Prism's own output.
 *  `token.types` carries only the specific types (`["tag","punctuation"]`), so
 *  emitting it alone produced `class="tag punctuation"` and **no syntax rule
 *  ever matched, for any language, in any scope** — the whole `--syn-*` palette
 *  was unreachable. prism-react-renderer's own `getTokenProps` prepends it; this
 *  renders spans by hand and has to do the same. */
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
