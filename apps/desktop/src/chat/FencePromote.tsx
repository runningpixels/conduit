/// Holds Prism source until a rich fence destination is paint-ready, then
/// promotes once with a height-held opacity crossfade (§8.5 settle).

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

export interface FencePromoteProps {
  /** Surface shown while streaming / while the rich target prepares. */
  outgoing: ReactNode;
  /** Mermaid / KaTeX / artifact card — may mount early so async work can start. */
  incoming: ReactNode;
  /** True when `incoming` is paint-ready (or failed into a stable fallback). */
  ready: boolean;
}

function prefersReducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute('data-reduce-motion') === 'on';
}

/**
 * Source-first promote shell. While `!ready`, only `outgoing` is visible.
 * `incoming` stays mounted (opacity 0 / inert) so async work like Mermaid can
 * run. On `ready`, lock the outgoing height and crossfade; reduce-motion skips
 * the fade but still waits for ready.
 */
export function FencePromote({ outgoing, incoming, ready }: FencePromoteProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [showIncoming, setShowIncoming] = useState(false);
  const [fading, setFading] = useState(false);
  const [keepOutgoing, setKeepOutgoing] = useState(true);
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!ready) {
      setShowIncoming(false);
      setFading(false);
      setKeepOutgoing(true);
      setMinHeight(undefined);
      return;
    }

    const height = shellRef.current?.getBoundingClientRect().height;
    if (height && height > 0) {
      setMinHeight(height);
    }

    if (prefersReducedMotion()) {
      setShowIncoming(true);
      setFading(false);
      setKeepOutgoing(false);
      setMinHeight(undefined);
      return;
    }

    setShowIncoming(true);
    setFading(false);
    const id = window.requestAnimationFrame(() => setFading(true));
    return () => window.cancelAnimationFrame(id);
  }, [ready]);

  // jsdom and some embeds never fire transitionend — don't leave the source
  // layer mounted forever after the fade should have finished.
  useEffect(() => {
    if (!fading || !keepOutgoing) return;
    const t = window.setTimeout(() => {
      setKeepOutgoing(false);
      setMinHeight(undefined);
    }, 200);
    return () => window.clearTimeout(t);
  }, [fading, keepOutgoing]);

  function finishPromote() {
    setKeepOutgoing(false);
    setMinHeight(undefined);
  }

  const style: CSSProperties | undefined =
    minHeight != null ? { minHeight } : undefined;

  return (
    <div ref={shellRef} className="fence-promote" style={style}>
      {keepOutgoing && (
        <div
          className={fading ? 'fence-promote-outgoing is-exit' : 'fence-promote-outgoing'}
          aria-hidden={showIncoming || undefined}
        >
          {outgoing}
        </div>
      )}
      <div
        className={
          showIncoming && (fading || !keepOutgoing)
            ? 'fence-promote-incoming is-shown'
            : 'fence-promote-incoming is-preparing'
        }
        aria-hidden={!showIncoming || undefined}
        onTransitionEnd={(e) => {
          if (e.propertyName === 'opacity' && fading) {
            finishPromote();
          }
        }}
      >
        {incoming}
      </div>
    </div>
  );
}

/** Flip true after one animation frame — for sync destinations (KaTeX, cards). */
export function useSyncPromoteReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const id = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(id);
  }, []);
  return ready;
}
