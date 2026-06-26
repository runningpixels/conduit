import { parseMessageSegments, type MessageSegment, type ArtifactCandidate } from './messageSegments';

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

const KIND_LABEL: Record<ArtifactCandidate['kind'], string> = {
  markdown: 'Markdown',
  text: 'Text',
  code: 'Code',
  json: 'JSON',
  html: 'HTML',
};

interface ChatMessageContentProps {
  content: string;
  streaming?: boolean;
}

function renderProse(text: string, streaming: boolean, isLast: boolean) {
  const raw = text || (streaming && isLast ? '' : '…');
  const parts = raw.split('`');
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      nodes.push(<code key={`c${i}`} dangerouslySetInnerHTML={{ __html: escapeHtml(part) }} />);
    } else if (part) {
      nodes.push(<span key={`t${i}`} dangerouslySetInnerHTML={{ __html: escapeHtml(part) }} />);
    }
  });
  if (streaming && isLast) {
    nodes.push(<span key="cursor" className="cursor" />);
  }
  return <div className="prose"><p>{nodes}</p></div>;
}

function getKindLabel(kind: ArtifactCandidate['kind']): string {
  return KIND_LABEL[kind] ?? kind;
}

export function ChatMessageContent({ content, streaming }: ChatMessageContentProps) {
  const segments = parseMessageSegments(content);
  const nodes: React.ReactNode[] = [];
  segments.forEach((seg, idx) => {
    const isLast = idx === segments.length - 1;
    if (seg.type === 'prose') {
      nodes.push(<div key={`p${idx}`}>{renderProse(seg.text, !!streaming, isLast)}</div>);
    } else {
      if (streaming && isLast) {
        const label = getKindLabel(seg.candidate.kind);
        nodes.push(
          <div key={`f${idx}`} className="prose">
            <p>
              Writing {label} artifact…
              <span className="cursor" />
            </p>
          </div>
        );
      } else {
        const label = getKindLabel(seg.candidate.kind);
        const lineCount = seg.candidate.body.split('\n').length;
        const summary = `${label} artifact · ${lineCount} lines`;
        nodes.push(
          <details key={`f${idx}`} className="artifact-fence-block">
            <summary>{summary}</summary>
            <pre>{seg.candidate.body}</pre>
          </details>
        );
      }
    }
  });
  return <>{nodes}</>;
}
