/// "Start when": what begins a run on its own besides the user. A workflow
/// either runs when asked (or on a time schedule, set on its page) or watches
/// something: a feed for new posts, or its own folder for new files. Turning
/// the watch on happens with "Run automatically" on the workflow's page.

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
  const trigger = def.trigger;
  const choice: Choice = trigger?.kind ?? 'none';
  const minutes = trigger?.kind === 'feed' ? trigger.everyMinutes : 0;
  const choices: number[] = FEED_MINUTE_CHOICES.includes(minutes as (typeof FEED_MINUTE_CHOICES)[number])
    ? [...FEED_MINUTE_CHOICES]
    : [...FEED_MINUTE_CHOICES, minutes].filter((m) => m > 0).sort((a, b) => a - b);

  return (
    <section className="grp wf-trigger" aria-label={t('workspace.workflows.trigger.title')}>
      <div className="grp-label">{t('workspace.workflows.trigger.title')}</div>
      <label className="wf-field">
        <span>{t('workspace.workflows.trigger.when')}</span>
        <select
          className="sel"
          value={choice}
          onChange={(e) => {
            const next = e.target.value as Choice;
            onChange(withTrigger(def, next === 'none' ? null : newTrigger(next)));
          }}
        >
          <option value="none">{t('workspace.workflows.trigger.none')}</option>
          <option value="feed">{t('workspace.workflows.trigger.feed')}</option>
          <option value="folder">{t('workspace.workflows.trigger.folder')}</option>
        </select>
      </label>
      {trigger?.kind === 'feed' ? (
        <div className="wf-input-row">
          <label className="wf-field" htmlFor={urlId}>
            <span>{t('workspace.workflows.trigger.feedUrl')}</span>
            <input
              id={urlId}
              className="mem-input"
              type="url"
              value={trigger.url}
              onChange={(e) => onChange(withTrigger(def, { ...trigger, url: e.target.value }))}
            />
          </label>
          <label className="wf-field">
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
        </div>
      ) : null}
      {trigger ? (
        <p className="wf-muted">
          {trigger.kind === 'feed' ? t('workspace.workflows.trigger.feedHint') : t('workspace.workflows.trigger.folderHint')}
        </p>
      ) : null}
      {triggerNeedsFolder(def) ? <p className="wf-error">{t('workspace.workflows.trigger.needsFolder')}</p> : null}
    </section>
  );
}
