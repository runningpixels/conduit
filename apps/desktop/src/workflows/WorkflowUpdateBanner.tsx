/// A small strip at the top of the deck or Writing studio: a workflow changed
/// the document while someone was typing in it, so it was left alone. The same
/// note and "Reload" also appear in the chat thread; this one sits where the
/// person is working.

import { useT } from '../i18n';

export function WorkflowUpdateBanner({ workflow, onReload }: { workflow: string; onReload: () => void }) {
  const t = useT();
  return (
    <div className="workflow-update-banner" role="status">
      <span className="workflow-update-banner-text">{t('workspace.workflows.documentUpdated', { name: workflow })}</span>
      <button type="button" className="btn" onClick={onReload}>
        {t('workspace.workflows.documentReload')}
      </button>
    </div>
  );
}
