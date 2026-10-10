import type { ReactNode } from 'react';
import { useT } from '../i18n';

export interface ContextChip {
  id: string;
  label: string;
  icon: ReactNode;
  title?: string;
  /** Clicking the chip body opens the popover that owns this context. */
  onOpen?: () => void;
  /** Turns this context off. Omitted when there is no handler for it. */
  onRemove?: () => void;
  removeLabel: string;
}

interface ComposerContextChipsProps {
  chips: ContextChip[];
  /** While a turn streams the context is shown but cannot be changed. */
  disabled?: boolean;
}

/**
 * What this chat is using right now — folder, documents, skills, connector
 * resources, a chat-settings override — as removable chips above the input.
 * Web search and Research show on their own toggles in the bar instead. Renders nothing when nothing is active, so an unconfigured chat
 * looks exactly like a plain text box.
 */
export function ComposerContextChips({ chips, disabled = false }: ComposerContextChipsProps) {
  const t = useT();
  if (chips.length === 0) return null;
  return (
    <div className="composer-context" role="group" aria-label={t('chat.composer.chips.ariaLabel')}>
      {chips.map((chip) => (
        <span key={chip.id} className="composer-context-chip" title={chip.title}>
          <button
            className="composer-context-open"
            type="button"
            disabled={disabled || !chip.onOpen}
            onClick={chip.onOpen}
          >
            {chip.icon}
            <span className="composer-context-name">{chip.label}</span>
          </button>
          {chip.onRemove ? (
            <button
              className="composer-context-remove"
              type="button"
              aria-label={chip.removeLabel}
              title={chip.removeLabel}
              disabled={disabled}
              onClick={chip.onRemove}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
