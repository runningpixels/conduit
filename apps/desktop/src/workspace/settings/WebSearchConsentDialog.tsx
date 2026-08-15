import { useState } from 'react';

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
 *  Web-search consent: the first time a user enables
 *  web search (either globally in Settings or per turn in the chat bar), show
 *  this dialog. It explains what happens, links to provider pricing, and asks
 *  the user to explicitly allow.
 *
 *  "Allow" persists `web_search_consent_acknowledged = true` via a settings
 *  patch, so the dialog never reappears.
 *
 *  "Not now" reverts the toggle. If the user dismissed from the chat bar, the
 *  session-only flag prevents the dialog from re-triggering until the app
 *  restarts (same UX as the diagnostics disclosure, M6.5). */
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
        // Dismiss on backdrop click (not on dialog body click).
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
          internet during this conversation. Search queries are sent to the
          model provider (e.g. OpenAI), not to Conduit.
        </p>
        <p style={{ margin: 0, fontSize: '13px', color: 'var(--ink-2)', lineHeight: 1.6 }}>
          Each search call incurs a per-call cost on your provider account.
          See your provider's pricing page for current rates.
        </p>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-3)', lineHeight: 1.5 }}>
          Conduit never caches, indexes, or proxies web pages. Citations in the
          response come directly from the provider's search results.
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