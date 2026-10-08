/// The Documents collections a "Search my documents" step looks in: one
/// checkbox per collection, with a plain note when a saved choice is gone or
/// nothing is picked yet.

import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { listKnowledgeCollections } from '../ipc/client';
import type { KnowledgeCollection } from '../ipc/contracts';

export function CollectionPicker({
  value,
  onToggle,
}: {
  value: readonly string[];
  onToggle: (id: string, on: boolean) => void;
}) {
  const t = useT();
  const [all, setAll] = useState<KnowledgeCollection[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => listKnowledgeCollections())
      .then((list) => {
        if (!cancelled) setAll(list);
      })
      .catch(() => {
        // Without the list the card still shows the saved ids.
        if (!cancelled) setAll(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const gone = all ? value.filter((id) => !all.some((c) => c.id === id)) : [];
  return (
    <fieldset className="wf-tools">
      <legend>{t('workspace.workflows.editor.searchDocs.collections')}</legend>
      {all && all.length === 0 ? <p className="wf-muted">{t('workspace.workflows.editor.searchDocs.none')}</p> : null}
      {(all ?? []).map((c) => (
        <label key={c.id} className="wf-check">
          <input type="checkbox" checked={value.includes(c.id)} onChange={(e) => onToggle(c.id, e.target.checked)} />
          {t('workspace.workflows.editor.searchDocs.option', { name: c.name, count: c.documentCount })}
        </label>
      ))}
      {all === null
        ? value.map((id) => (
            <label key={id} className="wf-check">
              <input type="checkbox" checked onChange={(e) => onToggle(id, e.target.checked)} />
              {id}
            </label>
          ))
        : null}
      {gone.map((id) => (
        <label key={id} className="wf-check">
          <input type="checkbox" checked onChange={(e) => onToggle(id, e.target.checked)} />
          {t('workspace.workflows.editor.searchDocs.gone')}
        </label>
      ))}
      {value.length === 0 ? (
        <p className="wf-error" role="status">
          {t('workspace.workflows.editor.searchDocs.pick')}
        </p>
      ) : null}
    </fieldset>
  );
}
