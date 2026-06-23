import type { ContentBlockState } from './streamState';

interface ReasoningBlockProps {
  block: ContentBlockState;
}

/** v5 reasoning block: a subdued surface card under the prose. */
export function ReasoningBlock({ block }: ReasoningBlockProps) {
  return (
    <details className="reasoning-block">
      <summary>Reasoning</summary>
      <pre>{block.content}</pre>
    </details>
  );
}