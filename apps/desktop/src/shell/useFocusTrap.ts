import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * V7 focus trap (spec §9.2): while `active`, Tab / Shift+Tab cycle among the
 * focusable descendants of `ref.current` (wrapping first ↔ last) so keyboard
 * focus cannot escape a modal overlay. Remembers the element focused before
 * activation and restores focus to it on deactivate.
 *
 * The caller still owns open/close state, Escape handling, and initial focus.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    // Non-union alias: TS does not propagate the narrowing above into the
    // nested closures below, so capture the narrowed element explicitly.
    const trapRoot: HTMLElement = root;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    function focusableElements(): HTMLElement[] {
      return Array.from(trapRoot.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab') return;
      const focusables = focusableElements();
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;

      if (event.shiftKey) {
        if (active === first || (active !== null && !trapRoot.contains(active))) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || (active !== null && !trapRoot.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    trapRoot.addEventListener('keydown', handleKeyDown);
    return () => {
      trapRoot.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [ref, active]);
}
