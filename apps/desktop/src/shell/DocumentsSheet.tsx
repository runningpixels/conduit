import { useEffect, useRef } from 'react';
import type { AppSettings } from '../ipc/contracts';
import { KnowledgeSection } from '../workspace/settings/KnowledgeSection';
import { useT } from '../i18n';
import { useFocusTrap } from './useFocusTrap';

interface DocumentsSheetProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (next: AppSettings) => void;
  onStatus: (message: string) => void;
  /** Files dropped onto the window, waiting for a collection. */
  pendingPaths: string[];
  onPendingPathsHandled: () => void;
  /** `page`: the Documents rail destination (no scrim, no close). */
  variant?: 'sheet' | 'page';
}

/**
 * The knowledge base's own home (t1-8), opened from the sidebar.
 *
 * It was a section inside Settings, which is where you configure something
 * you already know about, not where you work with your documents. None of the
 * eleven products surveyed for t1-8 kept documents in a settings screen.
 *
 * A sheet rather than a main-area view on purpose: the shell has no routing
 * for non-chat views, and every other summoned surface (Settings, the command
 * palette) is an overlay. Copying that keeps this one change instead of two.
 *
 * `onSettingsChange` receives settings that `KnowledgeSection` has already
 * persisted, so it is a plain setter — not Settings' debounced auto-save,
 * which would write the same value a second time.
 */
export function DocumentsSheet({
  open,
  onClose,
  settings,
  onSettingsChange,
  onStatus,
  pendingPaths,
  onPendingPathsHandled,
  variant = 'sheet',
}: DocumentsSheetProps) {
  const isPage = variant === 'page';
  const t = useT();
  const sheetRef = useRef<HTMLDivElement>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open || isPage) return;
    lastFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sheetRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      lastFocusRef.current?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open || isPage) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose, isPage]);

  useFocusTrap(sheetRef, open && !isPage);

  if (!open) return null;

  const main = (
        <div className="sheet-main scroll">
          <div className="sheet-single-head">
            <h2 className="sheet-h">{t('shell.documentsSheet.heading')}</h2>
            {!isPage && (
              <button className="btn ghost" type="button" onClick={onClose}>
                {t('common.actions.close')}
              </button>
            )}
          </div>
          <p className="sheet-sub">{t('shell.documentsSheet.intro')}</p>
          <KnowledgeSection
            settings={settings}
            onUpdate={onSettingsChange}
            onStatus={onStatus}
            pendingPaths={pendingPaths}
            onPendingPathsHandled={onPendingPathsHandled}
          />
        </div>
  );

  if (isPage) {
    return (
      <section className="sheet sheet-single sheet-page" aria-label={t('shell.documentsSheet.ariaLabel')}>
        {main}
      </section>
    );
  }

  return (
    <div
      className="scrim"
      data-open="true"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={sheetRef}
        className="sheet sheet-single"
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.documentsSheet.ariaLabel')}
      >
        {main}
      </div>
    </div>
  );
}
