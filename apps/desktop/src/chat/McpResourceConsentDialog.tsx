import type { ConnectorResourceInfo } from '../ipc/contracts';
import { useT } from '../i18n';

interface McpResourceConsentDialogProps {
  resource: ConnectorResourceInfo;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * First-use acknowledgement before any of a connector's resources are sent to
 * the model provider (M5).
 *
 * Asked once per connector, not per resource: a server offering a dozen files
 * would be unusable otherwise, and the connector is the trust boundary
 * everywhere else in this app. The answer is stored in `tool_approval_memory`
 * and enforced Rust-side in `connector_runtime::resources`, so this dialog is
 * where the user is asked — not where the decision is kept.
 */
export function McpResourceConsentDialog({
  resource,
  onConfirm,
  onCancel,
}: McpResourceConsentDialogProps) {
  const t = useT();

  return (
    <div
      className="composer-mcp-consent-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div
        className="composer-mcp-consent-dialog"
        role="dialog"
        aria-label={t('chat.mcpResourceConsent.ariaLabel')}
        style={{
          background: 'var(--card)',
          borderRadius: 'var(--r-lg)',
          padding: 20,
          maxWidth: 420,
          width: '90%',
          boxShadow: 'var(--shadow-modal-strong)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: '0 0 8px', fontSize: 'var(--fs-5xl)' }}>
          {t('chat.mcpResourceConsent.title')}
        </h3>
        <p style={{ margin: '0 0 12px', fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
          {t('chat.mcpResourceConsent.body', { connector: resource.connectorName })}
        </p>
        <p style={{ margin: '0 0 16px', fontSize: 'var(--fs-lg)', color: 'var(--ink-3)' }}>
          {t('chat.mcpResourceConsent.scopeNote')}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t('chat.mcpResourceConsent.cancel')}
          </button>
          <button type="button" className="btn primary" autoFocus onClick={onConfirm}>
            {t('chat.mcpResourceConsent.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
