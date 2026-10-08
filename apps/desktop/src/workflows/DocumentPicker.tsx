/// The deck or draft an "Update a deck / draft" step changes: a list of the
/// ones that can be edited (title and size), with a plain note when the saved
/// choice is gone or not ready, or when nothing is chosen yet.

import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n';
import { listDecks, listDrafts } from '../ipc/client';
import type { DeckSummary, DraftSummary } from '../ipc/contracts';
import { deckChoices, draftChoices, targetState } from './documentChoices';

const KEYS = {
  deck: {
    label: 'workspace.workflows.editor.editDeck.label',
    choose: 'workspace.workflows.editor.editDeck.choose',
    deleted: 'workspace.workflows.editor.editDeck.deleted',
    notReady: 'workspace.workflows.editor.editDeck.notReady',
    pick: 'workspace.workflows.editor.editDeck.pick',
    option: 'workspace.workflows.editor.editDeck.option',
  },
  draft: {
    label: 'workspace.workflows.editor.editDraft.label',
    choose: 'workspace.workflows.editor.editDraft.choose',
    deleted: 'workspace.workflows.editor.editDraft.deleted',
    notReady: 'workspace.workflows.editor.editDraft.notReady',
    pick: 'workspace.workflows.editor.editDraft.pick',
    option: 'workspace.workflows.editor.editDraft.option',
  },
} as const;

export function DocumentPicker({
  kind,
  value,
  onChange,
}: {
  kind: 'deck' | 'draft';
  value: string;
  onChange: (id: string) => void;
}) {
  const t = useT();
  const selectId = useId();
  const [all, setAll] = useState<(DeckSummary | DraftSummary)[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then((): Promise<(DeckSummary | DraftSummary)[]> => (kind === 'deck' ? listDecks() : listDrafts()))
      .then((list) => {
        if (!cancelled) setAll(list);
      })
      .catch(() => {
        // Without the list the card still shows the saved id.
        if (!cancelled) setAll(null);
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);

  const ready = all ? (kind === 'deck' ? deckChoices(all as DeckSummary[]) : draftChoices(all as DraftSummary[])) : [];
  const state = all ? targetState(value, all, ready) : value.trim() === '' ? 'unset' : 'ok';
  const keys = KEYS[kind];
  const optionText = (item: DeckSummary | DraftSummary) =>
    t(keys.option, {
      title: item.title,
      count: kind === 'deck' ? (item as DeckSummary).slideCount : (item as DraftSummary).words,
    });
  const stale = state === 'deleted' || state === 'notReady';
  const known = all?.find((item) => item.id === value);

  return (
    <div className="wf-field">
      <label htmlFor={selectId}>
        <span>{t(keys.label)}</span>
      </label>
      <select id={selectId} className="sel" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t(keys.choose)}</option>
        {ready.map((item) => (
          <option key={item.id} value={item.id}>
            {optionText(item)}
          </option>
        ))}
        {stale ? <option value={value}>{known ? known.title : value}</option> : null}
        {all === null && value ? <option value={value}>{value}</option> : null}
      </select>
      {state === 'deleted' ? (
        <p className="wf-error" role="status">
          {t(keys.deleted)}
        </p>
      ) : null}
      {state === 'notReady' ? (
        <p className="wf-error" role="status">
          {t(keys.notReady)}
        </p>
      ) : null}
      {state === 'unset' ? (
        <p className="wf-error" role="status">
          {t(keys.pick)}
        </p>
      ) : null}
    </div>
  );
}
