import { useRef } from 'react';

/**
 * Tracks a live-updating value and hands back a React key that only changes
 * when the value itself does. Pairing that key with a remount (`<span
 * className="value-flash" key={flashKey(value)}>`) makes the CSS animation on
 * `.value-flash` (terminal.css) replay on every change — React remounts an
 * element whose key changed, and a freshly-mounted element with the class
 * already present starts its animation.
 *
 * The first render never flashes: `flashKey` starts at 0 for whatever value
 * is passed in initially, so callers should apply `value-flash` only once
 * `flashKey > 0` (see `StatusLine.tsx`). Without that, every figure would
 * flash the moment the app opens, which is not a change — it is the first
 * paint.
 *
 * The animation itself is defined only under `html[data-look="terminal"]`
 * (terminal.css `.value-flash`), so this hook is a no-op everywhere else: the
 * class is present, there is just no rule to animate it. Reduced motion is
 * handled globally (`tokens.css` collapses every `animation-duration` under
 * `html[data-reduce-motion="on"]`), so this hook does not need to know about it.
 */
export function useFlashKey(value: string | number): number {
  const prevValue = useRef(value);
  const keyRef = useRef(0);
  if (prevValue.current !== value) {
    prevValue.current = value;
    keyRef.current += 1;
  }
  return keyRef.current;
}
