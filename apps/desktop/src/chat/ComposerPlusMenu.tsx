import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { PlusIcon } from '../icons';
import { useT } from '../i18n';
import { Menu } from '../workspace/Menu';

export interface PlusMenuItem {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  /** Present for a checkbox item: rendered as `menuitemcheckbox`. */
  checked?: boolean;
}

interface ComposerPlusMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: PlusMenuItem[];
  disabled?: boolean;
  title?: string;
}

/**
 * The composer's single "+" button and its menu. Everything that used to be
 * its own icon in the bar (attach, web search, folder, documents, skills,
 * connector prompts and resources, chat settings) is one item here, shown
 * only when its feature is available. The menu is the shared `Menu`, so it
 * keeps the one keyboard model every menu has.
 */
export const ComposerPlusMenu = forwardRef<HTMLButtonElement, ComposerPlusMenuProps>(
  function ComposerPlusMenu({ open, onOpenChange, items, disabled = false, title }, ref) {
    const t = useT();
    const triggerRef = useRef<HTMLButtonElement>(null);
    useImperativeHandle(ref, () => triggerRef.current as HTMLButtonElement);
    const isOpen = open && !disabled;

    return (
      <>
        <button
          ref={triggerRef}
          className={`cbtn composer-plus-btn${isOpen ? ' armed' : ''}`}
          type="button"
          aria-label={t('chat.composer.plus.ariaLabel')}
          title={title ?? t('chat.composer.plus.title')}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          disabled={disabled}
          onClick={() => onOpenChange(!isOpen)}
          onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
            // The menu button pattern: Down (or Up) on the button opens it.
            if (!isOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              onOpenChange(true);
            }
          }}
        >
          <PlusIcon />
        </button>
        <Menu
          open={isOpen}
          onClose={() => onOpenChange(false)}
          triggerRef={triggerRef}
          className="menu composer-plus-menu"
          label={t('chat.composer.plus.menuLabel')}
          dismissOnOutsidePress
        >
          {items.map((item) => {
            const checkbox = item.checked !== undefined;
            return (
              <button
                key={item.id}
                className="menu-item"
                type="button"
                role={checkbox ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={checkbox ? item.checked : undefined}
                title={item.title}
                disabled={item.disabled}
                onClick={() => {
                  onOpenChange(false);
                  item.onSelect();
                }}
              >
                {item.icon}
                <span>{item.label}</span>
                {checkbox ? (
                  <span className="tail">
                    {item.checked ? t('chat.composer.plus.on') : t('chat.composer.plus.off')}
                  </span>
                ) : null}
              </button>
            );
          })}
        </Menu>
      </>
    );
  },
);
