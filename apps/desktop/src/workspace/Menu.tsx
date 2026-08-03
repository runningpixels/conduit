import {
  useEffect,
  useId,
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
}

/**
 * Lightweight menu: Escape closes, arrow keys move among menuitems,
 * focus returns to the trigger. Caller still owns open state + outside click.
 */
export function Menu({ open, onClose, triggerRef, children, className, label }: MenuProps) {
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
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose]);

  if (!open) return null;

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
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
    >
      {children}
    </div>
  );
}
