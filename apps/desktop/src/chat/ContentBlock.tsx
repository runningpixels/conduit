import type { ContentBlockState } from './streamState';

interface ContentBlockProps {
  block: ContentBlockState;
  streaming?: boolean;
}

/** Escapes a string for safe insertion into HTML text. Model-generated content
 *  is never rendered as raw HTML in this phase. */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Renders a prose paragraph. Inline `code spans` become chips, matching v5.
 *  The streaming cursor is appended to the last block while streaming. */
export function ContentBlock({ block, streaming }: ContentBlockProps) {
  const raw = block.content || (streaming ? '' : '…');
  // Split on backtick-delimited code spans; even indices are text, odd are code.
  const parts = raw.split('`');
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      nodes.push(
        <code key={`c${i}`} dangerouslySetInnerHTML={{ __html: escapeHtml(part) }} />,
      );
    } else if (part) {
      nodes.push(<span key={`t${i}`} dangerouslySetInnerHTML={{ __html: escapeHtml(part) }} />);
    }
  });
  if (streaming) {
    nodes.push(<span key="cursor" className="cursor" />);
  }
  return (
    <div className="prose">
      <p>{nodes}</p>
    </div>
  );
}