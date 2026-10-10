import type { ReactNode } from 'react';
import { useT } from '../i18n';
import type { SlashCommandId } from './slashTrigger';

export interface SlashMenuOption {
  id: SlashCommandId;
  label: string;
  icon: ReactNode;
  /** Present for an on/off tool (Web, Research): its current state. */
  on?: boolean;
}

/** The DOM id an option renders at, for the textarea's `aria-activedescendant`. */
export function slashOptionId(id: SlashCommandId): string {
  return `composer-slash-option-${id}`;
}

interface ComposerSlashMenuProps {
  /** Id of the `role="listbox"` itself, for the textarea's `aria-controls`. */
  id: string;
  options: SlashMenuOption[];
  activeIndex: number;
  onHover: (index: number) => void;
  onPick: (option: SlashMenuOption) => void;
}

/**
 * The `/` tools popover. The same shape as the `#` document picker: anchored
 * above the composer, never focused (the textarea keeps focus and drives it
 * through `aria-activedescendant`), and picked on `mousedown` so a mouse pick
 * never blurs the textarea first. Only rendered while something matches.
 */
export function ComposerSlashMenu({ id, options, activeIndex, onHover, onPick }: ComposerSlashMenuProps) {
  const t = useT();
  return (
    <div className="composer-doc-picker composer-slash-menu">
      <ul id={id} role="listbox" aria-label={t('chat.composer.tools.slashAriaLabel')}>
        {options.map((option, index) => (
          <li
            key={option.id}
            id={slashOptionId(option.id)}
            role="option"
            aria-selected={index === activeIndex}
            data-active={index === activeIndex}
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onPick(option);
            }}
          >
            {option.icon}
            <b>{`/${option.id}`}</b>
            <small>{option.label}</small>
            {option.on ? <span className="tail">{t('chat.composer.plus.on')}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
