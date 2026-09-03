import { useEffect, useState } from 'react';
import type { ContentBlockState } from './streamState';
import {
  readShowReasoning,
  SHOW_REASONING_CHANGED_EVENT,
  type ShowReasoningPref,
} from '../shell/uiPrefs';
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
 *  tool call — reasoning is a tool the model ran on itself. Local `open`
 *  state survives stream re-renders; Chat defaults "Always show/hide"
 *  sets the initial state and updates live chips via a window event. */
export function ReasoningBlock({ block }: ReasoningBlockProps) {
  const [open, setOpen] = useState(() => readShowReasoning() === 'on');

  useEffect(() => {
    function onPref(event: Event) {
      const detail = (event as CustomEvent<ShowReasoningPref>).detail;
      setOpen(detail === 'on');
    }
    window.addEventListener(SHOW_REASONING_CHANGED_EVENT, onPref);
    return () => window.removeEventListener(SHOW_REASONING_CHANGED_EVENT, onPref);
  }, []);

  const seconds = estimateSeconds(block.content);
  return (
    <details
      className="think"
      open={open}
      onToggle={(e) => {
        setOpen((e.currentTarget as HTMLDetailsElement).open);
      }}
    >
      <summary>
        <ChevronRight />
        {seconds != null ? `Thought for ${seconds}s` : 'Thought'}
      </summary>
      <pre>{block.content}</pre>
    </details>
  );
}
