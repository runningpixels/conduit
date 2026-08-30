import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { appName } from '../brand';

export interface OpenExternalLinkDialogProps {
  /** When null, the dialog is hidden. */
  url: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Claude-style confirmation before opening an http(s) URL from an artifact
 * preview in the system browser. Lives in app chrome (not the sandboxed iframe)
 * so we do not need `allow-modals`.
 */
export function OpenExternalLinkDialog({ url, onConfirm, onCancel }: OpenExternalLinkDialogProps) {
  const open = url != null;
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onCancel]);

  if (!open || url == null) return null;

  return (
    <div
      className="consent-overlay"
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="consent-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="open-external-link-title"
        aria-describedby="open-external-link-desc"
        style={{
          background: 'var(--card)',
          borderRadius: 'var(--r-md, 8px)',
          padding: '24px',
          maxWidth: '480px',
          width: '90%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          display: 'grid',
          gap: 16,
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="open-external-link-title" style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
          Open external link
        </h2>
        <p
          id="open-external-link-desc"
          style={{ margin: 0, fontSize: '13px', color: 'var(--ink-2)', lineHeight: 1.6 }}
        >
          You&apos;re leaving {appName()} to visit an external link:
        </p>
        <input
          type="text"
          readOnly
          value={url}
          aria-label="External URL"
          onFocus={(e) => e.currentTarget.select()}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            font: '12px/1.4 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
            padding: '8px 10px',
            borderRadius: 'var(--r-sm, 6px)',
            border: '1px solid var(--line, #333)',
            background: 'var(--bg-2, transparent)',
            color: 'var(--ink-1)',
          }}
        />
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button ref={cancelRef} className="btn ghost" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" type="button" onClick={onConfirm}>
            Open link
          </button>
        </div>
      </div>
    </div>
  );
}
