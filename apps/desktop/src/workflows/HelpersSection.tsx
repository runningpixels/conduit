/// The workflow's Helpers: agents an agent step (or another helper) may hand
/// work to. Each has a name, instructions, an optional model, tools, the
/// helpers it may hand on to and an optional token limit. The id comes from the
/// name when the helper is added and never changes after, because steps refer to it.
/// A helper may also be one of the user's agents: a small read-only card (the
/// agent itself is edited on the Agents page) that can be copied here to change
/// for this workflow only. An inline helper can be saved to the user's agents.

import { useState } from 'react';
import { useLibraryAgents } from '../agents/useLibraryAgents';
import { useT } from '../i18n';
import { createLibraryAgent } from '../ipc/client';
import type { AgentDef, LibraryAgent, WorkflowDefinition } from '../ipc/contracts';
import { AgentConnectorTools } from './AgentConnectorTools';
import {
  AGENT_TOOLS,
  COMPUTER_TOOL,
  DEFAULT_HELPER_TOKENS,
  MAX_HELPERS,
  MAX_HELPER_LINKS,
  MAX_HELPER_TOKENS,
  MIN_HELPER_TOKENS,
  detachLibraryHelper,
  helpersOf,
  newHelper,
  removeHelper,
  toLibraryRef,
  updateHelper,
  withBuiltinTool,
  withConnectorTool,
  withHelperLink,
  withHelperModel,
  withHelperTokens,
  withHelpers,
  withLibraryHelper,
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
  const library = useLibraryAgents();
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const inLibrary = (id: string): LibraryAgent | undefined => library.agents?.find((a) => a.agent.id === id);
  /// Your agents this workflow doesn't use yet.
  const available = (library.agents ?? []).filter((a) => !helpers.some((h) => h.id === a.agent.id));
  const set = (id: string, fn: (h: AgentDef) => AgentDef) => onChange(updateHelper(def, id, fn));

  /// Save an inline helper to the user's agents and turn it into a reference to the saved one.
  /// Its hand-offs go along only when every one of them is itself one of the user's agents.
  const saveToLibrary = async (helper: AgentDef) => {
    const linked = helper.agents ?? [];
    const keepLinks = linked.length > 0 && linked.every((id) => Boolean(helpers.find((h) => h.id === id)?.library));
    const { agents: _links, ...rest } = helper;
    setSaving(helper.id);
    setSaveError(null);
    try {
      const saved = await createLibraryAgent(keepLinks ? { ...rest, agents: linked } : rest);
      onChange(toLibraryRef(def, helper.id, saved.agent.id));
      library.reload();
    } catch (e) {
      setSaveError(t('workspace.workflows.helpers.saveFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="wfe-section wfe-helpers" aria-labelledby="wfe-helpers-title">
      <h3 className="wfe-h" id="wfe-helpers-title">
        {t('workspace.workflows.helpers.title')}
      </h3>
      <p className="wfe-help">{t('workspace.workflows.helpers.hint')}</p>
      {helpers.map((helper, index) => {
        if (helper.library) {
          const agent = inLibrary(helper.library)?.agent;
          const name = agent?.name || library.names[helper.library] || helper.id;
          const tools = agent?.tools ?? [];
          const others = tools.filter((x) => x !== COMPUTER_TOOL).length;
          return (
            <fieldset key={helper.id} className="wfe-helper wfe-helper-library" data-helper-id={helper.id}>
              <div className="wfe-helper-head">
                <span className="wfe-helper-title">
                  <b>{name}</b>
                  <span className="wf-muted">{t('workspace.workflows.helpers.fromLibrary')}</span>
                </span>
                {agent ? (
                  <button
                    type="button"
                    className="btn ghost"
                    aria-label={t('workspace.workflows.helpers.copyHereLabel', { name })}
                    onClick={() => onChange(detachLibraryHelper(def, helper.id, agent))}
                  >
                    {t('workspace.workflows.helpers.copyHere')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn ghost"
                  aria-label={t('workspace.workflows.helpers.remove', { name })}
                  onClick={() => onChange(removeHelper(def, helper.id))}
                >
                  {t('workspace.workflows.helpers.removeShort')}
                </button>
              </div>
              {agent ? (
                <p className="wf-muted">
                  {[
                    agent.model ? agent.model.model : t('shell.agents.workflowModel'),
                    tools.includes(COMPUTER_TOOL) ? t('shell.agents.usesComputer') : null,
                    others > 0 ? t('shell.agents.tools', { count: others }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : library.agents ? (
                <p className="wf-error">{t('workspace.workflows.helpers.missing', { id: helper.library })}</p>
              ) : null}
            </fieldset>
          );
        }
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
                disabled={saving !== null}
                aria-label={t('workspace.workflows.helpers.saveToLibraryLabel', { name: label })}
                onClick={() => void saveToLibrary(helper)}
              >
                {t('workspace.workflows.helpers.saveToLibrary')}
              </button>
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
              folder={def.folder}
              computer={def.computer}
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
                      {other.name || (other.library ? library.names[other.library] : '') || other.id}
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
      {saveError ? (
        <p className="wf-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <div className="wfe-helper-add">
        <button
          type="button"
          className="btn ghost wfe-add-value"
          disabled={helpers.length >= MAX_HELPERS}
          onClick={() => onChange(withHelpers(def, [...helpers, newHelper(helpers, t('workspace.workflows.helpers.newName'))]))}
        >
          {t('workspace.workflows.helpers.add')}
        </button>
        {available.length > 0 ? (
          <select
            className="mem-input wfe-helper-pick"
            aria-label={t('workspace.workflows.helpers.addFromLibrary')}
            disabled={helpers.length >= MAX_HELPERS}
            value=""
            onChange={(e) => {
              if (e.target.value) onChange(withLibraryHelper(def, e.target.value));
            }}
          >
            <option value="">{t('workspace.workflows.helpers.addFromLibrary')}</option>
            {available.map((a) => (
              <option key={a.agent.id} value={a.agent.id}>
                {a.agent.name || a.agent.id}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </section>
  );
}
