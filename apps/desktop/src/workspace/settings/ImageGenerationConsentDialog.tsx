import { useState } from 'react';
import { useRichT, useT } from '../../i18n';

interface ImageGenerationConsentDialogProps {
  /** True when the dialog should be visible. The parent controls this. */
  visible: boolean;
  /** Called when the user clicks "Allow". Persists the acknowledgement. */
  onAllow: () => void;
  /** Called when the user clicks "Not now". The turn still sends, without
   *  the tool -- see `ChatView.tsx`'s pre-send gate. */
  onDeny: () => void;
}

/** One-time consent dialog for image generation (t0-8 M4).
 *
 *  Structural copy of `WebSearchConsentDialog`: same overlay/dialog markup,
 *  same button pair, same one-time-then-persisted shape. Raised pre-send
 *  from `ChatView.tsx`'s `handleSend` -- image generation has no toggle to
 *  intercept the way `handleWebSearchToggle` does, so this fires the first
 *  time a turn's prompt actually asks for an image on a capable provider.
 */
export function ImageGenerationConsentDialog({
  visible,
  onAllow,
  onDeny,
}: ImageGenerationConsentDialogProps) {
  const t = useT();
  const tr = useRichT();
  const [acknowledging, setAcknowledging] = useState(false);

  if (!visible) return null;

  return (
    <div
      className="consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('chat.imageGeneration.consent.dialogAriaLabel')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onDeny();
      }}
    >
      <div
        className="consent-dialog"
        style={{
          background: 'var(--card)',
          borderRadius: 'var(--r-sm)',
          padding: '24px',
          maxWidth: '440px',
          width: '90%',
          boxShadow: 'var(--shadow-modal)',
          display: 'grid',
          gap: 16,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--fs-8xl)', fontWeight: 600 }}>
          {t('chat.imageGeneration.consent.title')}
        </h2>
        <p style={{ margin: 0, fontSize: 'var(--fs-3xl)', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {t('chat.imageGeneration.consent.intro')}
        </p>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--fs-3xl)', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          <li>{tr('chat.imageGeneration.consent.costItem')}</li>
        </ul>
        <p style={{ margin: 0, fontSize: 'var(--fs-xl)', color: 'var(--ink-3)', lineHeight: 1.5 }}>
          {t('chat.imageGeneration.consent.privacyNote')}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            className="btn ghost"
            type="button"
            disabled={acknowledging}
            onClick={onDeny}
          >
            {t('common.actions.notNow')}
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={acknowledging}
            onClick={() => {
              setAcknowledging(true);
              onAllow();
            }}
          >
            {t('common.actions.allow')}
          </button>
        </div>
      </div>
    </div>
  );
}
