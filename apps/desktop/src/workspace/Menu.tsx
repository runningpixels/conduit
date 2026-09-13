import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  /** Element that opened the menu — focus returns here on close. */
  triggerRef: React.RefObject<HTMLElement | null>;
  children: ReactNode;
  className?: string;
  label?: string;
  /**
   * Close on a press anywhere outside the menu and its trigger. A press on the
   * trigger is left to the trigger, so a toggle button still toggles.
   */
  dismissOnOutsidePress?: boolean;
  /**
   * Open at a point rather than under a trigger — a context menu. The menu is
   * fixed-positioned there and nudged back inside the viewport, so a row near
   * the bottom or right edge does not open a menu half off-screen.
   */
  anchorPoint?: { x: number; y: number };
}

/** Gap kept between a point-anchored menu and the viewport edge. */
const VIEWPORT_MARGIN = 8;

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * Lightweight menu: Escape closes, arrow keys move among menuitems, focus moves
 * to the first item on open and returns to the trigger on close. Every menu in
 * the shell uses it, so they all answer the keyboard the same way.
 */
export function Menu({
  open,
  onClose,
  triggerRef,
  children,
  className,
  label,
  dismissOnOutsidePress = false,
  anchorPoint,
}: MenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    const items = menu?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])');
    items?.[0]?.focus();

    return () => {
      triggerRef.current?.focus();
    };
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    function handleKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      // Down from the trigger enters the menu (the WAI-ARIA menu button
      // pattern). Also what reaches items that arrive after opening, such as
      // a model list still loading when the first-item focus ran.
      if (event.key === 'ArrowDown' && document.activeElement === triggerRef.current) {
        const first = menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose, triggerRef]);

  useEffect(() => {
    if (!open || !dismissOnOutsidePress) return;
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onClose();
    }
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open, dismissOnOutsidePress, onClose, triggerRef]);

  // Before paint, so a clamped menu never flashes at its unclamped position.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !anchorPoint || !menu) return;
    const rect = menu.getBoundingClientRect();
    const left = Math.max(VIEWPORT_MARGIN, Math.min(anchorPoint.x, window.innerWidth - rect.width - VIEWPORT_MARGIN));
    const top = Math.max(VIEWPORT_MARGIN, Math.min(anchorPoint.y, window.innerHeight - rect.height - VIEWPORT_MARGIN));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [open, anchorPoint]);

  if (!open) return null;

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // A text field inside a menu (the model picker's model-id row) keeps its
    // own Home, End and arrows.
    if (isEditable(event.target)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  }

  return (
    <div
      ref={menuRef}
      className={className ?? 'menu'}
      data-open="true"
      role="menu"
      aria-label={label}
      aria-labelledby={label ? undefined : labelId}
      onKeyDown={onMenuKeyDown}
      style={anchorPoint ? { position: 'fixed', left: anchorPoint.x, top: anchorPoint.y } : undefined}
    >
      {children}
    </div>
  );
}
