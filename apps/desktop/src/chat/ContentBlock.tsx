import type { ContentBlockState } from './streamState';
import { ChatProse } from './ChatProse';

interface ContentBlockProps {
  block: ContentBlockState;
  streaming?: boolean;
  showCitations?: boolean;
}

/** Renders a content block with optional inline citations (delegates to ChatProse). */
export function ContentBlock({ block, streaming, showCitations = true }: ContentBlockProps) {
  return (
    <ChatProse
      content={block.content}
      citations={block.citations}
      streaming={streaming}
      showCitations={showCitations}
    />
  );
}
