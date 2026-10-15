/// How agents that use the computer behave in this workflow: whether they ask
/// before changing files, what a question does when nobody answers, and how
/// long a command may run. Shown in the Start panel only when an agent or
/// helper has the computer tool.

import { useId } from 'react';
import { useT } from '../i18n';
import type { WorkflowComputer, WorkflowDefinition } from '../ipc/contracts';
import { DEFAULT_COMPUTER_TIMEOUT_SECS, MAX_COMPUTER_TIMEOUT_SECS, withComputer } from './editorModel';

export function WorkflowComputerSection({
  def,
  onChange,
}: {
  def: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const t = useT();
  const id = useId();
  const computer = def.computer ?? {};
  const set = (patch: Partial<WorkflowComputer>) => onChange(withComputer(def, { ...computer, ...patch }));
  const editMode = computer.editMode ?? 'ask';
  const whenNobody = computer.whenNobodyAnswers ?? 'wait';
  const outside = computer.allowOutside === true;

  return (
    <section className="wfe-section wfe-computer" aria-labelledby={`${id}-title`}>
      <h3 className="wfe-h" id={`${id}-title`}>
        {t('workspace.workflows.computerSettings.title')}
      </h3>
      <p className="wfe-help">{t('workspace.workflows.computerSettings.hint')}</p>
      {def.folder ? null : <p className="wfe-help">{t('workspace.workflows.computerSettings.noFolder')}</p>}

      <fieldset className="wf-tools">
        <legend>{t('workspace.workflows.computerSettings.editMode')}</legend>
        <label className="wf-check">
          <input type="radio" name={`${id}-edit`} checked={editMode === 'ask'} onChange={() => set({ editMode: 'ask' })} />
          {t('workspace.workflows.computerSettings.editAsk')}
        </label>
        <label className="wf-check">
          <input type="radio" name={`${id}-edit`} checked={editMode === 'free'} onChange={() => set({ editMode: 'free' })} />
          {t('workspace.workflows.computerSettings.editFree')}
        </label>
      </fieldset>

      <fieldset className="wf-tools">
        <legend>{t('workspace.workflows.computerSettings.whenNobody')}</legend>
        <label className="wf-check">
          <input
            type="radio"
            name={`${id}-nobody`}
            checked={whenNobody === 'wait'}
            onChange={() => set({ whenNobodyAnswers: 'wait' })}
          />
          {t('workspace.workflows.computerSettings.wait')}
        </label>
        <label className="wf-check">
          <input
            type="radio"
            name={`${id}-nobody`}
            checked={whenNobody === 'skip'}
            onChange={() => set({ whenNobodyAnswers: 'skip' })}
          />
          {t('workspace.workflows.computerSettings.skip')}
        </label>
      </fieldset>

      <label className="wfe-field">
        <span>{t('workspace.workflows.computerSettings.timeout')}</span>
        <input
          className="mem-input wf-narrow"
          type="number"
          min={1}
          max={MAX_COMPUTER_TIMEOUT_SECS}
          step={1}
          placeholder={String(DEFAULT_COMPUTER_TIMEOUT_SECS)}
          value={computer.timeoutSecs ?? ''}
          onChange={(e) => {
            const { timeoutSecs: _drop, ...rest } = computer;
            const n = Number(e.target.value);
            onChange(
              withComputer(def, e.target.value === '' || !Number.isFinite(n) ? rest : { ...rest, timeoutSecs: Math.round(n) }),
            );
          }}
        />
      </label>

      <details className={`wfe-advanced${outside ? ' is-warn' : ''}`} open={outside || undefined}>
        <summary>{t('workspace.workflows.computerSettings.advanced')}</summary>
        <label className="wf-check">
          <input type="checkbox" checked={outside} onChange={(e) => set({ allowOutside: e.target.checked })} />
          {t('workspace.workflows.computerSettings.allowOutside')}
        </label>
        <p className="wfe-help">{t('workspace.workflows.computerSettings.allowOutsideHint')}</p>
        {outside ? <p className="wfe-warn">{t('workspace.workflows.computerSettings.outsideWarn')}</p> : null}
      </details>
    </section>
  );
}
