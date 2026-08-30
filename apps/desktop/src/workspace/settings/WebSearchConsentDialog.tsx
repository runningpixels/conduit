import { useState } from 'react';
import { appName } from '../../brand';

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
 *  Conduit's local DuckDuckGo builtin (queries leave this machine to DuckDuckGo).
 *  Settings → Search source chooses which path a turn uses.
 */
export function WebSearchConsentDialog({ visible, onAllow, onDeny }: WebSearchConsentDialogProps) {
  const [acknowledging, setAcknowledging] = useState(false);

  if (!visible) return null;

  return (
    <div
      className="consent-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Web search consent"
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
          Enable web search?
        </h2>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          When you turn on web search, the model can look things up on the
          internet during this conversation. Where the query goes depends on
          Settings → Web Search → Search source:
        </p>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: '13px', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          <li>
            <strong>Provider</strong> — queries go to the model provider’s hosted
            search (e.g. OpenAI), not to {appName()}. Each call may incur provider cost.
          </li>
          <li>
            <strong>Local</strong> — {appName()} searches DuckDuckGo from this machine.
            Queries are not sent to the model provider.
          </li>
          <li>
            <strong>Auto</strong> — provider-hosted when available; otherwise local DuckDuckGo.
          </li>
        </ul>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-3)', lineHeight: 1.5 }}>
          {appName()} does not cache or index the web. Local-only mode keeps web search off.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            className="btn ghost"
            type="button"
            disabled={acknowledging}
            onClick={onDeny}
          >
            Not now
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
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
