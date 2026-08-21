import type { ContentBlockState } from './streamState';
import { readShowReasoning } from '../shell/uiPrefs';
import { ChevronRight } from '../icons';

interface ReasoningBlockProps {
  block: ContentBlockState;
}

/** Estimate the "Thought for Ns" label from the reasoning text: roughly
 *  15 words per second of fast reading. Degrades to "Thought" when empty. */
function estimateSeconds(content: string): number | undefined {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return undefined;
  return Math.max(1, Math.min(60, Math.round(words / 15)));
}

/** V7 reasoning block (§8.5): deliberately the same one-line pattern as a
 *  tool call — reasoning is a tool the model ran on itself. Dashed left
 *  border, mono body, default collapsed; "Show reasoning" in Chat defaults
 *  flips the default open state. */
export function ReasoningBlock({ block }: ReasoningBlockProps) {
  const defaultOpen = readShowReasoning() === 'on';
  const seconds = estimateSeconds(block.content);
  return (
    <details className="think" open={defaultOpen}>
      <summary>
        <ChevronRight />
        {seconds != null ? `Thought for ${seconds}s` : 'Thought'}
      </summary>
      <pre>{block.content}</pre>
    </details>
  );
}
