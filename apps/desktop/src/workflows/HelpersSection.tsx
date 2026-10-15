/// The workflow's Helpers: agents an agent step (or another helper) may hand
/// work to. Each has a name, instructions, an optional model, tools, the
/// helpers it may hand on to and an optional token limit. The id comes from the
/// name when the helper is added and never changes after, because steps refer to it.

import { useT } from '../i18n';
import type { AgentDef, WorkflowDefinition } from '../ipc/contracts';
import { AgentConnectorTools } from './AgentConnectorTools';
import {
  AGENT_TOOLS,
  DEFAULT_HELPER_TOKENS,
  MAX_HELPERS,
  MAX_HELPER_LINKS,
  MAX_HELPER_TOKENS,
  MIN_HELPER_TOKENS,
  helpersOf,
  newHelper,
  removeHelper,
  updateHelper,
  withBuiltinTool,
  withConnectorTool,
  withHelperLink,
  withHelperModel,
  withHelperTokens,
  withHelpers,
} from './editorModel';
import { agentToolText } from './permissionText';
import { ComputerToolOption } from './ComputerToolOption';
import { WorkflowModelRow } from './WorkflowModelRow';

export function HelpersSection({
  def,
  onChange,
}: {
  def: WorkflowDefinition;
  onChange: (next: WorkflowDefinition) => void;
}) {
  const t = useT();
  const helpers = helpersOf(def);
  const set = (id: string, fn: (h: AgentDef) => AgentDef) => onChange(updateHelper(def, id, fn));

  return (
    <section className="wfe-section wfe-helpers" aria-labelledby="wfe-helpers-title">
      <h3 className="wfe-h" id="wfe-helpers-title">
        {t('workspace.workflows.helpers.title')}
      </h3>
      <p className="wfe-help">{t('workspace.workflows.helpers.hint')}</p>
      {helpers.map((helper, index) => {
        const others = helpers.filter((h) => h.id !== helper.id);
        const linked = helper.agents ?? [];
        const label = helper.name || helper.id;
        return (
          <fieldset key={helper.id} className="wfe-helper" data-helper-id={helper.id}>
            <div className="wfe-helper-head">
              <input
                className="mem-input"
                aria-label={t('workspace.workflows.helpers.name', { n: index + 1 })}
                placeholder={t('workspace.workflows.helpers.namePlaceholder')}
                value={helper.name}
                onChange={(e) => set(helper.id, (h) => ({ ...h, name: e.target.value }))}
              />
              <button
                type="button"
                className="btn ghost"
                aria-label={t('workspace.workflows.helpers.remove', { name: label })}
                onClick={() => onChange(removeHelper(def, helper.id))}
              >
                {t('workspace.workflows.helpers.removeShort')}
              </button>
            </div>
            <label className="wfe-field">
              <span>{t('workspace.workflows.helpers.instructions')}</span>
              <textarea
                className="mem-input"
                rows={3}
                aria-label={t('workspace.workflows.helpers.instructionsFor', { name: label })}
                placeholder={t('workspace.workflows.helpers.instructionsPlaceholder')}
                value={helper.instructions}
                onChange={(e) => set(helper.id, (h) => ({ ...h, instructions: e.target.value }))}
              />
            </label>
            <WorkflowModelRow
              kind="step"
              idPrefix={`wf-helper-model-${helper.id}`}
              label={t('workspace.workflows.model.helperLabel')}
              model={helper.model}
              onChange={(model) => set(helper.id, (h) => withHelperModel(h, model))}
            />
            <fieldset className="wf-tools">
              <legend>{t('workspace.workflows.editor.agent.tools')}</legend>
              {AGENT_TOOLS.map((tool) => (
                <label key={tool} className="wf-check">
                  <input
                    type="checkbox"
                    checked={(helper.tools ?? []).includes(tool)}
                    onChange={(e) => set(helper.id, (h) => ({ ...h, tools: withBuiltinTool(h.tools ?? [], tool, e.target.checked) }))}
                  />
                  {agentToolText(tool, t)}
                </label>
              ))}
            </fieldset>
            <ComputerToolOption
              tools={helper.tools ?? []}
              hasFolder={Boolean(def.folder?.trim())}
              onChange={(tools) => set(helper.id, (h) => ({ ...h, tools }))}
            />
            <AgentConnectorTools
              tools={helper.tools ?? []}
              onToggle={(ref, on) => set(helper.id, (h) => ({ ...h, tools: withConnectorTool(h.tools ?? [], ref, on) }))}
            />
            {others.length > 0 ? (
              <fieldset className="wf-tools">
                <legend>{t('workspace.workflows.helpers.handsTo')}</legend>
                {others.map((other) => {
                  const on = linked.includes(other.id);
                  return (
                    <label key={other.id} className="wf-check">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!on && linked.length >= MAX_HELPER_LINKS}
                        onChange={(e) => set(helper.id, (h) => withHelperLink(h, other.id, e.target.checked))}
                      />
                      {other.name || other.id}
                    </label>
                  );
                })}
              </fieldset>
            ) : null}
            <label className="wfe-field wf-narrow">
              <span>{t('workspace.workflows.helpers.tokens')}</span>
              <input
                className="mem-input"
                type="number"
                min={MIN_HELPER_TOKENS}
                max={MAX_HELPER_TOKENS}
                step={1000}
                placeholder={String(DEFAULT_HELPER_TOKENS)}
                value={helper.maxTokens ?? ''}
                onChange={(e) =>
                  set(helper.id, (h) => withHelperTokens(h, e.target.value === '' ? null : Number(e.target.value)))
                }
              />
            </label>
          </fieldset>
        );
      })}
      <button
        type="button"
        className="btn ghost wfe-add-value"
        disabled={helpers.length >= MAX_HELPERS}
        onClick={() => onChange(withHelpers(def, [...helpers, newHelper(helpers, t('workspace.workflows.helpers.newName'))]))}
      >
        {t('workspace.workflows.helpers.add')}
      </button>
    </section>
  );
}
