import { useState } from 'react';
import { useRichT, useT } from '../../i18n';

interface WebSearchConsentDialogProps {
  /** True when the dialog should be visible. The parent controls this. */
  visible: boolean;
  /** Called when the user clicks "Allow". Persists the acknowledgement. */
  onAllow: () => void;
  /** Called when the user clicks "Not now". Reverts the toggle. */
  onDeny: () => void;
}

/** One-time consent dialog for web search.
 *
 *  Covers both provider-hosted search (queries go to the model provider) and
 *  Conduit's local search builtin (DuckDuckGo / Tavily / Brave / SearXNG).
 *  Settings → Search source chooses which path a turn uses.
 */
export function WebSearchConsentDialog({ visible, onAllow, onDeny }: WebSearchConsentDialogProps) {
  const t = useT();
  const tr = useRichT();
  const [acknowledging, setAcknowledging] = useState(false);

  if (!visible) return null;

  return (
    <div
      className="consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.webSearch.consent.dialogAriaLabel')}
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
          borderRadius: 'var(--r-md, 8px)',
          padding: '24px',
          maxWidth: '440px',
          width: '90%',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
          display: 'grid',
          gap: 16,
        }}
      >
        <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 600 }}>
          {t('settings.webSearch.consent.title')}
        </h2>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {t('settings.webSearch.consent.intro')}
        </p>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: '13px', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          <li>{tr('settings.webSearch.consent.hostedItem')}</li>
          <li>{tr('settings.webSearch.consent.localItem')}</li>
          <li>{tr('settings.webSearch.consent.autoItem')}</li>
        </ul>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-3)', lineHeight: 1.5 }}>
          {t('settings.webSearch.consent.privacyNote')}
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
