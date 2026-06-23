/// Hand-rolled safe-subset Markdown renderer (M6). Returns React nodes — never
/// HTML strings, never `dangerouslySetInnerHTML`. Every text node is emitted as
/// a React text child (React escapes by construction), so raw HTML in the
/// source renders as escaped visible text, not parsed markup.
///
/// Supported subset:
/// - Fenced code blocks (```lang ... ```), headings (#..######), unordered
///   lists (- * +), ordered lists (N.), blockquotes (>), horizontal rules
///   (--- / *** / ___), paragraphs.
/// - Inline: **bold**, *italic*, `code` chips, [text](url) links, bare
///   https?:// autolinks.
///
/// URL allowlist: only http:, https:, mailto: scheme links render as `<a>`.
/// javascript:, data:, vbscript:, and whitespace/control-prefixed URLs are
/// rejected and render as escaped plain text (the original markdown). Link
/// targets open in a new browsing context with `rel="noopener noreferrer"`.
///
/// This is deliberately a small subset — not CommonMark. Unknown constructs
/// render as plain escaped text. The hardened Code/JSON/Plain/HTML renderers
/// live alongside this in `renderers.tsx` / `HtmlArtifactRenderer.tsx`.

import { Fragment, type ReactNode } from 'react';

const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/// True if `url` is an allowlisted, non-suspicious link target. Rejects
/// `javascript:`/`data:`/`vbscript:`, and any URL whose first character is a
/// control/whitespace char (a common bypass: `  javascript:`).
function isSafeUrl(url: string): boolean {
  if (url.length === 0) return false;
  const first = url.codePointAt(0);
  if (first == null || first <= 0x20) return false; // whitespace/control
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Bare `mailto:foo@example.com` is a valid URL; everything else must parse.
    return false;
  }
  return LINK_SCHEMES.has(parsed.protocol);
}

type Block =
  | { type: 'code'; lang?: string; code: string }
  | { type: 'heading'; level: number; inline: string }
  | { type: 'blockquote'; inline: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'rule' }
  | { type: 'paragraph'; inline: string };

const FENCE = /^```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const UL_ITEM = /^[-*+]\s+(.*)$/;
const OL_ITEM = /^(\d+)\.\s+(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip (paragraph separator).
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Fenced code block: ```lang ... ```.
    const fence = FENCE.exec(line.trim());
    if (fence) {
      const lang = fence[1].trim() || undefined;
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i].trim())) {
        code.push(lines[i]);
        i++;
      }
      i++; // consume closing fence (if present)
      blocks.push({ type: 'code', lang, code: code.join('\n') });
      continue;
    }

    // Horizontal rule.
    if (RULE.test(line.trim())) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }

    // Heading.
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, inline: h[2].trim() });
      i++;
      continue;
    }

    // Blockquote (consecutive `>` lines join into one).
    if (line.trimStart().startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) {
        buf.push(lines[i].trimStart().slice(1).trimStart());
        i++;
      }
      blocks.push({ type: 'blockquote', inline: buf.join(' ') });
      continue;
    }

    // Unordered list (consecutive list items).
    if (UL_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length && UL_ITEM.test(lines[i])) {
        items.push(UL_ITEM.exec(lines[i])![1].trim());
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list.
    if (OL_ITEM.test(line)) {
      const items: string[] = [];
      while (i < lines.length && OL_ITEM.test(lines[i])) {
        items.push(OL_ITEM.exec(lines[i])![2].trim());
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Paragraph: consecutive non-blank, non-special lines.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !FENCE.test(lines[i].trim()) &&
      !HEADING.test(lines[i]) &&
      !RULE.test(lines[i].trim()) &&
      !lines[i].trimStart().startsWith('>') &&
      !UL_ITEM.test(lines[i]) &&
      !OL_ITEM.test(lines[i])
    ) {
      buf.push(lines[i].trim());
      i++;
    }
    blocks.push({ type: 'paragraph', inline: buf.join(' ') });
  }

  return blocks;
}

/// Inline parser. Walks the string with a cursor, emitting React nodes. Raw
/// HTML (`<...>`) is treated as ordinary text — React escapes it on render.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let k = 0;
  const push = (node: ReactNode) => {
    nodes.push(node);
    k++;
  };
  const flush = () => {
    if (buf) {
      push(<Fragment key={`${keyPrefix}-t${k}`}>{buf}</Fragment>);
      buf = '';
    }
  };

  while (i < text.length) {
    const rest = text.slice(i);

    // Inline code span: `...` (single backticks; content is escaped plain text).
    const codeMatch = /^`([^`]+)`/.exec(rest);
    if (codeMatch) {
      flush();
      push(<code key={`${keyPrefix}-c${k}`} className="md-code">{codeMatch[1]}</code>);
      i += codeMatch[0].length;
      continue;
    }

    // Link: [text](url). Only allowlisted URLs become anchors.
    const linkMatch = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
    if (linkMatch) {
      const label = linkMatch[1];
      const url = linkMatch[2];
      if (isSafeUrl(url)) {
        flush();
        push(
          <a key={`${keyPrefix}-l${k}`} href={url} target="_blank" rel="noopener noreferrer">
            {label}
          </a>,
        );
      } else {
        // Unsafe URL: render the whole `[text](url)` as escaped plain text.
        buf += linkMatch[0];
      }
      i += linkMatch[0].length;
      continue;
    }

    // Autolink: bare https?://... up to whitespace.
    const autoMatch = /^https?:\/\/[^\s<]+/.exec(rest);
    if (autoMatch) {
      flush();
      const url = autoMatch[0];
      push(
        <a key={`${keyPrefix}-a${k}`} href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>,
      );
      i += url.length;
      continue;
    }

    // Bold: **...**
    const boldMatch = /^\*\*([^*]+)\*\*/.exec(rest);
    if (boldMatch) {
      flush();
      push(<strong key={`${keyPrefix}-b${k}`}>{boldMatch[1]}</strong>);
      i += boldMatch[0].length;
      continue;
    }

    // Italic: *...*
    const italicMatch = /^\*([^*]+)\*/.exec(rest);
    if (italicMatch) {
      flush();
      push(<em key={`${keyPrefix}-i${k}`}>{italicMatch[1]}</em>);
      i += italicMatch[0].length;
      continue;
    }

    // Ordinary character — accumulate into the text buffer (React escapes it).
    buf += text[i];
    i++;
  }
  flush();
  return nodes;
}

/// Render a Markdown source string into a fragment of block elements.
export function renderMarkdown(src: string): ReactNode {
  const blocks = parseBlocks(src);
  return (
    <>
      {blocks.map((block, idx) => {
        const key = `md-${idx}`;
        switch (block.type) {
          case 'code':
            return (
              <pre key={key} className="md-pre">
                <code>{block.code}</code>
              </pre>
            );
          case 'heading': {
            const Tag = (`h${Math.min(Math.max(block.level, 1), 6)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
            return <Tag key={key}>{renderInline(block.inline, key)}</Tag>;
          }
          case 'blockquote':
            return (
              <blockquote key={key} className="md-quote">
                {renderInline(block.inline, key)}
              </blockquote>
            );
          case 'ul':
            return (
              <ul key={key}>
                {block.items.map((item, j) => (
                  <li key={`${key}-li${j}`}>{renderInline(item, `${key}-li${j}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={key}>
                {block.items.map((item, j) => (
                  <li key={`${key}-li${j}`}>{renderInline(item, `${key}-li${j}`)}</li>
                ))}
              </ol>
            );
          case 'rule':
            return <hr key={key} className="md-rule" />;
          case 'paragraph':
            return <p key={key}>{renderInline(block.inline, key)}</p>;
        }
      })}
    </>
  );
}