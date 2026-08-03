import type { ContentBlockState } from './streamState';
import { readShowReasoning } from '../shell/uiPrefs';

interface ReasoningBlockProps {
  block: ContentBlockState;
}

/** V7 reasoning block: the same one-line disclosure pattern as a tool call.
 *  Default collapsed; "Show reasoning" in Chat defaults flips the default. */
export function ReasoningBlock({ block }: ReasoningBlockProps) {
  const defaultOpen = readShowReasoning() === 'on';
  return (
    <details className="reasoning-block" open={defaultOpen}>
      <summary>Reasoning</summary>
      <pre>{block.content}</pre>
    </details>
  );
}
