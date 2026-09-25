import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ContentBlockState } from './streamState';
import {
  readShowReasoning,
  SHOW_REASONING_CHANGED_EVENT,
  type ShowReasoningPref,
} from '../shell/uiPrefs';
import { ChevronRight } from '../icons';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';

interface ReasoningBlockProps {
  block: ContentBlockState;
  /// The model is still writing this block: the label counts up and the body
  /// follows the newest line.
  live?: boolean;
}

/// Within this many pixels of the bottom, the body keeps following new lines;
/// scrolling further up to read opts out. Same rule as `InlineCodeBlock`.
const FOLLOW_SLACK_PX = 24;

/** Re-render once a second while `active`, so a live label can count up. */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** V7 reasoning block (§8.5): deliberately the same one-line pattern as a
 *  tool call — reasoning is a tool the model ran on itself. Local `open`
 *  state survives stream re-renders; Chat defaults "Always show/hide"
 *  sets the initial state and updates live chips via a window event.
 *
 *  The label used to be "Thought for Ns" estimated from the word count at 15
 *  words a second and capped at 60, so ten minutes of reasoning read "Thought
 *  for 60s" — and while it was still thinking it said "Thought" too. It now
 *  reports the time the deltas actually spanned, counts up while live, and
 *  says only "Thought" when the timing was never recorded (a reloaded turn). */
export function ReasoningBlock({ block, live = false }: ReasoningBlockProps) {
  const t = useT();
  const fmt = useFormatters();
  const [open, setOpen] = useState(() => readShowReasoning() === 'on');
  const now = useSecondTick(live);

  useEffect(() => {
    function onPref(event: Event) {
      const detail = (event as CustomEvent<ShowReasoningPref>).detail;
      setOpen(detail === 'on');
    }
    window.addEventListener(SHOW_REASONING_CHANGED_EVENT, onPref);
    return () => window.removeEventListener(SHOW_REASONING_CHANGED_EVENT, onPref);
  }, []);

  // The open body is height-capped, so while live it follows the tail — the
  // same reason, and the same opt-out, as a streaming code fence.
  const bodyRef = useRef<HTMLPreElement>(null);
  const followRef = useRef(true);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (live && open && el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [block.content, live, open]);
  function handleScroll() {
    const el = bodyRef.current;
    if (!el || !live) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  }

  let label: string;
  if (live) {
    label =
      block.startedAt != null
        ? t('chat.reasoning.thinkingFor', { duration: fmt.duration(now - block.startedAt) })
        : t('chat.reasoning.thinking');
  } else if (block.startedAt != null && block.lastDeltaAt != null) {
    label = t('chat.reasoning.thoughtFor', {
      duration: fmt.duration(Math.max(1000, block.lastDeltaAt - block.startedAt)),
    });
  } else {
    label = t('chat.reasoning.thought');
  }

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
        {label}
      </summary>
      <pre ref={bodyRef} className="scroll" onScroll={handleScroll}>
        {block.content}
      </pre>
    </details>
  );
}
