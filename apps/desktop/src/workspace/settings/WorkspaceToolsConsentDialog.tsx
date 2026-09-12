import { useState } from 'react';
import { useRichT, useT } from '../../i18n';

interface WorkspaceToolsConsentDialogProps {
  visible: boolean;
  onAllow: () => void;
  onDeny: () => void;
}

/** One-time consent for workspace file tools (read/write under a chosen folder). */
export function WorkspaceToolsConsentDialog({
  visible,
  onAllow,
  onDeny,
}: WorkspaceToolsConsentDialogProps) {
  const t = useT();
  const tr = useRichT();
  const [acknowledging, setAcknowledging] = useState(false);

  if (!visible) return null;

  return (
    <div
      className="consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('settings.workspaceTools.consent.ariaLabel')}
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
          {t('settings.workspaceTools.consent.title')}
        </h2>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {tr('settings.workspaceTools.consent.filesHint')}
        </p>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          {t('settings.workspaceTools.consent.writesHint')}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn ghost" type="button" disabled={acknowledging} onClick={onDeny}>
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
