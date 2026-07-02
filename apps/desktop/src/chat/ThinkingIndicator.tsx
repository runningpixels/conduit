/**
 * ThinkingIndicator — animated dots and label shown inside an assistant message
 * while the provider is generating a response but no content blocks exist yet.
 *
 * Matches the v5 design language: three pulsing accent dots + a brief label.
 * Renders in-message (inside the assistant bubble), not in the status footer.
 */

import { useEffect, useRef, useState } from 'react';
import type { AssistantStreamState } from './streamState';

export interface ThinkingIndicatorProps {
  /** Optional model identifier shown in the label. */
  modelId?: string;
  /** Agent loop phase, if in one. */
  phase?: AssistantStreamState['agentPhase'];
  /** Custom message override. */
  message?: string;
  /** Whether this indicator is visible (for minimum display time logic). */
  visible?: boolean;
}

/** Minimum time (ms) the indicator should stay visible to prevent flicker. */
const MIN_DISPLAY_MS = 300;

export function ThinkingIndicator({ modelId, phase, message, visible = true }: ThinkingIndicatorProps) {
  const [show, setShow] = useState(visible);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (visible) {
      shownAt.current = Date.now();
      setShow(true);
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    } else {
      const elapsed = shownAt.current ? Date.now() - shownAt.current : 0;
      const remaining = Math.max(0, MIN_DISPLAY_MS - elapsed);
      hideTimer.current = setTimeout(() => {
        setShow(false);
        shownAt.current = null;
      }, remaining);
    }
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [visible]);

  if (!show) return null;

  const label = message
    ?? phase?.label
    ?? (modelId ? `${modelId} is thinking` : 'Thinking');

  return (
    <div className="thinking-indicator" role="status" aria-live="polite">
      <span className="thinking-dots" aria-hidden="true">
        <span className="thinking-dot" />
        <span className="thinking-dot" />
        <span className="thinking-dot" />
      </span>
      <span className="thinking-label">{label}&hellip;</span>
    </div>
  );
}