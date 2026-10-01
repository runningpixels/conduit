/// The reader's side of page model access (ADR-014): a banner when a page's
/// first `window.conduit.llm.complete()` call is waiting on a decision, and
/// the consent dialog that names the provider and says plainly whether text
/// leaves the device. Styled like `ArtifactNetworkBanner`/`ArtifactNetworkDialog`
/// (`workspace/ArtifactNetwork.tsx`), simplified: there is one thing to grant
/// per page, not one per site, so there is no site list and no "any site"
/// checkbox.

import { useEffect, useRef } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { useT } from '../i18n';
import { ModelIcon } from '../icons';
import type { PageLlmState } from '../ipc/client';
import type { PageLlmDecision } from './usePageLlm';

// ── Banner ───────────────────────────────────────────────────────────────────

export function PageLlmBanner({
  pending,
  onReview,
  onNotNow,
}: {
  pending: boolean;
  onReview: () => void;
  onNotNow: () => void;
}) {
  const t = useT();
  if (!pending) return null;
  return (
    <div className="doc-banner hold page-llm-banner" role="status">
      <span className="page-llm-banner-text">
        <ModelIcon />
        {t('artifacts.llm.banner.text')}
      </span>
      <div className="row">
        <button type="button" className="btn ghost" onClick={onNotNow}>
          {t('artifacts.llm.banner.notNow')}
        </button>
        <button type="button" className="btn primary" onClick={onReview}>
          {t('artifacts.llm.banner.review')}
        </button>
      </div>
    </div>
  );
}

// ── Consent dialog ───────────────────────────────────────────────────────────

export function PageLlmDialog({
  open,
  title,
  state,
  onDecide,
}: {
  open: boolean;
  title: string | null;
  state: PageLlmState | null;
  onDecide: (decision: PageLlmDecision) => void;
}) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const denyRef = useRef<HTMLButtonElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    denyRef.current?.focus();
    // Capture phase: the panel's own Escape (close the document) must not see
    // this one.
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onDecide('deny');
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, onDecide]);

  if (!open || !state) return null;

  return (
    <div className="consent-overlay page-llm-overlay" role="presentation">
      <div
        ref={dialogRef}
        className="consent-dialog page-llm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="page-llm-title"
      >
        <h2 id="page-llm-title">
          {title ? t('artifacts.llm.dialog.title', { title }) : t('artifacts.llm.dialog.titleUntitled')}
        </h2>
        <div className="page-llm-provider">
          <ModelIcon />
          <b>{state.providerName}</b>
        </div>
        <p className="page-llm-note">
          {state.isLocal
            ? t('artifacts.llm.dialog.local')
            : t('artifacts.llm.dialog.cloud', { provider: state.providerName })}
        </p>
        <div className="page-llm-actions">
          <button ref={denyRef} type="button" className="btn ghost" onClick={() => onDecide('deny')}>
            {t('artifacts.llm.dialog.deny')}
          </button>
          <button type="button" className="btn" onClick={() => onDecide('session')}>
            {t('artifacts.llm.dialog.allowSession')}
          </button>
          <button type="button" className="btn primary" onClick={() => onDecide('page')}>
            {t('artifacts.llm.dialog.allowPage')}
          </button>
        </div>
      </div>
    </div>
  );
}
