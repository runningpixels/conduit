/// The bar that floats over selected text in the draft: Rewrite, Shorter,
/// Longer, Clearer, Fix grammar, and Ask… (type your own instruction). Each
/// sends one chat message about the selected blocks; the editor builds the
/// request, this only picks the action.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import { SELECTION_ACTIONS, SELECTION_ACTION_IDS, type SelectionAction } from './selectionMessage';

export interface SelectionToolbarProps {
  /** Where to draw it, in pixels inside the editor's frame. */
  position: { top: number; left: number };
  /** The selection includes the user's own (pinned) text. */
  touchesPinned: boolean;
  onAction: (action: SelectionAction, instruction?: string) => void;
  onDismiss: () => void;
}

export function SelectionToolbar({ position, touchesPinned, onAction, onDismiss }: SelectionToolbarProps) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [instruction, setInstruction] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (asking) inputRef.current?.focus();
  }, [asking]);

  const sendAsk = () => {
    const text = instruction.trim();
    if (text === '') return;
    onAction('ask', text);
    setInstruction('');
    setAsking(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      // The studio's own Escape handling must not also close something else.
      event.stopPropagation();
      event.preventDefault();
      if (asking) setAsking(false);
      else onDismiss();
    }
  };

  return (
    <div
      className="draft-selection-bar"
      role="toolbar"
      aria-label={t('writing.selection.aria')}
      style={{ top: position.top, left: position.left }}
      // Keep the editor's selection: a mousedown here would otherwise move it.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
      onKeyDown={onKeyDown}
    >
      {asking ? (
        <form
          className="draft-selection-ask"
          onSubmit={(e) => {
            e.preventDefault();
            sendAsk();
          }}
        >
          <input
            ref={inputRef}
            className="draft-selection-input"
            type="text"
            value={instruction}
            maxLength={500}
            aria-label={t('writing.selection.askAria')}
            placeholder={t('writing.selection.askPlaceholder')}
            onChange={(e) => setInstruction(e.target.value)}
          />
          <button type="submit" className="btn primary" disabled={instruction.trim() === ''}>
            {t('writing.selection.send')}
          </button>
        </form>
      ) : (
        SELECTION_ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            className="draft-selection-btn"
            onClick={() => (action === 'ask' ? setAsking(true) : onAction(action))}
          >
            {t(SELECTION_ACTION_IDS[action].label)}
          </button>
        ))
      )}
      {touchesPinned && !asking && (
        <span className="draft-selection-note">{t('writing.selection.pinnedNote')}</span>
      )}
    </div>
  );
}
