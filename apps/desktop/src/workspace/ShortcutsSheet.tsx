import { useEffect, useId, useRef } from 'react';
import { useT } from '../i18n';
import { escapeKeyHint, modShiftShortcutHint, modShortcutHint } from '../lib/shortcuts';
import { useFocusTrap } from '../shell/useFocusTrap';
import { HOTKEYS, type HotkeyBinding } from './useHotkeys';

interface ShortcutsSheetProps {
  open: boolean;
  onClose: () => void;
}

const GROUPS: { id: HotkeyBinding['group']; labelId: string }[] = [
  { id: 'general', labelId: 'workspace.shortcuts.group.general' },
  { id: 'layout', labelId: 'workspace.shortcuts.group.layout' },
  { id: 'chat', labelId: 'workspace.shortcuts.group.chat' },
];

/** The hint for a binding, in the platform's own notation. */
export function bindingHint(binding: HotkeyBinding): string {
  return binding.shift === true ? modShiftShortcutHint(binding.display) : modShortcutHint(binding.display);
}

/**
 * Keyboard shortcuts (Mod+/). The app binds ten Mod shortcuts, and until this
 * the only place most of them were written down was a tooltip on whichever
 * control happened to share the action — Fork, Copy last message and Switch
 * provider had none at all.
 *
 * Rendered from `HOTKEYS`, the table `useHotkeys` matches against, so the sheet
 * lists exactly what is bound.
 */
export function ShortcutsSheet({ open, onClose }: ShortcutsSheetProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (open) dialogRef.current?.querySelector<HTMLElement>('button')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="cu-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className="cu-dialog shortcuts-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="shortcuts-head">
          <h2 className="cu-dialog-title" id={titleId}>
            {t('workspace.shortcuts.title')}
          </h2>
          <button
            className="iconbtn"
            type="button"
            aria-label={t('workspace.shortcuts.closeAriaLabel')}
            title={t('workspace.shortcuts.closeAriaLabel')}
            onClick={onClose}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        {GROUPS.map((group) => (
          <section key={group.id} className="shortcuts-group" aria-label={t(group.labelId)}>
            <h3 className="shortcuts-group-title">{t(group.labelId)}</h3>
            <dl className="shortcuts-list">
              {HOTKEYS.filter((binding) => binding.group === group.id).map((binding) => (
                <div key={binding.id} className="shortcuts-row">
                  <dt>{t(binding.labelId)}</dt>
                  <dd>
                    <kbd>{bindingHint(binding)}</kbd>
                  </dd>
                </div>
              ))}
              {group.id === 'general' && (
                <div className="shortcuts-row">
                  <dt>{t('workspace.shortcuts.action.escape')}</dt>
                  <dd>
                    <kbd>{escapeKeyHint()}</kbd>
                  </dd>
                </div>
              )}
            </dl>
          </section>
        ))}
      </div>
    </div>
  );
}
