/// "Starts when": what begins a run on its own besides the user. A workflow
/// either runs when asked (or on a time schedule, set on its page) or watches
/// something: a feed for new posts, or its own folder for new files. Turning
/// the watch on happens with "Run automatically" on the workflow's page.
/// Three radio cards; the chosen one shows its own fields under it.

import { useId } from 'react';
import { useT } from '../i18n';
import type { WorkflowDefinition, WorkflowTrigger } from '../ipc/contracts';
import { clampFeedMinutes, FEED_MINUTE_CHOICES, newTrigger, triggerNeedsFolder, withTrigger } from './editorModel';

type Choice = 'none' | WorkflowTrigger['kind'];

export function TriggerSection({
  def,
  onChange,
}: {
  def: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const t = useT();
  const urlId = useId();
  const groupName = useId();
  const trigger = def.trigger;
  const choice: Choice = trigger?.kind ?? 'none';
  const minutes = trigger?.kind === 'feed' ? trigger.everyMinutes : 0;
  const choices: number[] = FEED_MINUTE_CHOICES.includes(minutes as (typeof FEED_MINUTE_CHOICES)[number])
    ? [...FEED_MINUTE_CHOICES]
    : [...FEED_MINUTE_CHOICES, minutes].filter((m) => m > 0).sort((a, b) => a - b);

  const pick = (next: Choice) => {
    if (next !== choice) onChange(withTrigger(def, next === 'none' ? null : newTrigger(next)));
  };
  const card = (value: Choice, title: string) => (
    <label className={`wfe-radio${choice === value ? ' is-selected' : ''}`}>
      <input type="radio" name={groupName} checked={choice === value} onChange={() => pick(value)} />
      <span>{title}</span>
    </label>
  );

  return (
    <fieldset className="wfe-fieldset">
      <legend className="wfe-h">{t('workspace.workflows.trigger.when')}</legend>
      <div className="wfe-radio-group">
        {card('none', t('workspace.workflows.trigger.none'))}
        {choice === 'none' ? <p className="wfe-help wfe-radio-extra">{t('workspace.workflows.editor.start.scheduleNote')}</p> : null}
        {card('feed', t('workspace.workflows.trigger.feed'))}
        {trigger?.kind === 'feed' ? (
          <div className="wfe-radio-extra">
            <label className="wfe-field" htmlFor={urlId}>
              <span>{t('workspace.workflows.trigger.feedUrl')}</span>
              <input
                id={urlId}
                className="mem-input"
                type="url"
                value={trigger.url}
                onChange={(e) => onChange(withTrigger(def, { ...trigger, url: e.target.value }))}
              />
            </label>
            <label className="wfe-field">
              <span>{t('workspace.workflows.trigger.every')}</span>
              <select
                className="sel"
                value={minutes}
                onChange={(e) =>
                  onChange(withTrigger(def, { ...trigger, everyMinutes: clampFeedMinutes(Number(e.target.value)) }))
                }
              >
                {choices.map((m) => (
                  <option key={m} value={m}>
                    {t('workspace.workflows.trigger.minutes', { count: m })}
                  </option>
                ))}
              </select>
            </label>
            <p className="wfe-help">{t('workspace.workflows.trigger.feedHint')}</p>
          </div>
        ) : null}
        {card('folder', t('workspace.workflows.trigger.folder'))}
        {trigger?.kind === 'folder' ? (
          <div className="wfe-radio-extra">
            <p className="wfe-help">{t('workspace.workflows.trigger.folderHint')}</p>
            {triggerNeedsFolder(def) ? <p className="wfe-error">{t('workspace.workflows.trigger.needsFolder')}</p> : null}
          </div>
        ) : null}
      </div>
    </fieldset>
  );
}
