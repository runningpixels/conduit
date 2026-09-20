import { useState } from 'react';
import { useT } from '../../i18n';

interface EmbeddingConsentDialogProps {
  /** True when the dialog should be visible. The parent controls this. */
  visible: boolean;
  /** The provider that will receive the document text, named in the copy. */
  providerId: string | null;
  /** Called when the user clicks "Allow". Persists the acknowledgement and
   *  the import proceeds. */
  onAllow: () => void;
  /** Called when the user clicks "Not now". The import is aborted and the
   *  document is left unindexed. */
  onDeny: () => void;
}

/**
 * One-time-per-provider consent dialog for knowledge base embedding (t1-6).
 *
 * Structural copy of `ImageGenerationConsentDialog` -- same overlay/dialog
 * markup, same button pair. This is the honest-disclosure surface for the
 * whole knowledge base feature: it must say plainly that the *text* of every
 * document added to the collection is sent to the named provider to be
 * embedded, not just the one about to be imported. Raised from
 * `KnowledgeSection`'s import flow, gated on `settings.embeddingConsentProviders`
 * not containing the collection's `providerId` -- per provider id, so
 * switching providers re-prompts instead of silently inheriting consent.
 */
export function EmbeddingConsentDialog({
  visible,
  providerId,
  onAllow,
  onDeny,
}: EmbeddingConsentDialogProps) {
  const t = useT();
  const [acknowledging, setAcknowledging] = useState(false);

  if (!visible) return null;

  return (
    <div
      className="consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.knowledge.consent.dialogAriaLabel')}
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
          {t('settings.knowledge.consent.title')}
        </h2>
        <p style={{ margin: 0, fontSize: 'var(--fs-3xl)', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {t('settings.knowledge.consent.intro', { provider: providerId ?? '' })}
        </p>
        <p style={{ margin: 0, fontSize: 'var(--fs-3xl)', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {t('settings.knowledge.consent.everyDocument', { provider: providerId ?? '' })}
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
