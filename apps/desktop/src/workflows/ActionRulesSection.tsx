/// A workflow's permissions, in two groups. Connectors: steps that send, post
/// or change something through a connector stop before each one and show
/// exactly what they will do; the user can allow single actions from that
/// prompt and takes them back here. This computer: which commands an agent may
/// run without asking, and which always ask first.
///
/// Shown in the workflow page's Permissions tab, only when the workflow has a
/// step that can act or when its rules are not the default (so they can still
/// be reset); see `hasPermissions`.

import { useState } from 'react';
import { useT } from '../i18n';
import { setWorkflowActionRules } from '../ipc/client';
import type { WorkflowActionRules, WorkflowComputer, WorkflowStep } from '../ipc/contracts';
import { rejectionText } from './CommandRuleList';
import { ComputerRules } from './ComputerRules';
import { usesConnectorTools } from './editorModel';
import { useRuleSuggestions } from './useActionRules';

function isDefault(rules: WorkflowActionRules): boolean {
  return !rules.allowAll && rules.allowed.length === 0 && !rules.commands?.allow.length && !rules.commands?.deny.length;
}

/// Whether a workflow has permissions worth a tab: it can act, or it already has rules.
export function hasPermissions(steps: readonly WorkflowStep[], usesComputer: boolean, rules: WorkflowActionRules | null): boolean {
  return usesConnectorTools(steps) || usesComputer || (rules !== null && !isDefault(rules));
}

export function ActionRulesSection({
  workflowId,
  steps,
  usesComputer = false,
  computer,
  rules,
  onRules,
  runKey,
}: {
  workflowId: string;
  steps: readonly WorkflowStep[];
  /// An agent or helper of this workflow uses the computer, so command rules matter.
  usesComputer?: boolean;
  /// The workflow's computer settings (edit mode, confinement), for the summary line.
  computer?: WorkflowComputer;
  rules: WorkflowActionRules;
  /// The backend took new rules.
  onRules: (next: WorkflowActionRules) => void;
  /// Changes when a run ends, so suggestions are read again.
  runKey?: unknown;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const connectors = usesConnectorTools(steps);
  const commands = rules.commands ?? { allow: [], deny: [] };
  const showCommands = usesComputer || commands.allow.length > 0 || commands.deny.length > 0;
  const showConnectors = connectors || rules.allowAll || rules.allowed.length > 0 || !showCommands;
  const { suggestions, dismiss } = useRuleSuggestions(workflowId, showCommands, runKey, commands.allow);

  const save = async (next: WorkflowActionRules): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      onRules(await setWorkflowActionRules(workflowId, next));
      return true;
    } catch (e) {
      setError(rejectionText(e) || t('workspace.workflows.outside.saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="wf-perm">
      {showConnectors ? (
        <section className="grp wf-actions wf-perm-group" aria-label={t('workspace.workflows.perm.connectors.title')}>
          <div className="grp-label">{t('workspace.workflows.perm.connectors.title')}</div>
          <p className="wf-perm-summary">
            {rules.allowAll
              ? t('workspace.workflows.perm.connectors.summaryAll')
              : rules.allowed.length > 0
                ? t('workspace.workflows.perm.connectors.summaryAllowed', { count: rules.allowed.length })
                : t('workspace.workflows.perm.connectors.summaryAsk')}
          </p>
          <p className="wf-muted">{t('workspace.workflows.outside.intro')}</p>
          <label className="wf-check">
            <input
              type="checkbox"
              checked={!rules.allowAll}
              disabled={saving}
              onChange={(e) => void save({ ...rules, allowAll: !e.target.checked })}
            />
            {t('workspace.workflows.outside.askEach')}
          </label>
          {rules.allowed.length === 0 ? (
            <p className="wf-muted">{t('workspace.workflows.outside.none')}</p>
          ) : (
            <>
              <p className="wf-muted">{t('workspace.workflows.outside.allowedLabel')}</p>
              <ul className="wf-actions-allowed">
                {rules.allowed.map((a) => (
                  <li key={`${a.connectorId}/${a.tool}`}>
                    <span>{t('workspace.workflows.outside.allowedItem', { tool: a.tool, connector: a.connectorName })}</span>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={saving}
                      aria-label={t('workspace.workflows.outside.removeLabel', { tool: a.tool, connector: a.connectorName })}
                      onClick={() =>
                        void save({
                          ...rules,
                          allowed: rules.allowed.filter((x) => !(x.connectorId === a.connectorId && x.tool === a.tool)),
                        })
                      }
                    >
                      {t('workspace.workflows.outside.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}
      {showCommands ? (
        <ComputerRules
          commands={commands}
          computer={computer}
          busy={saving}
          suggestions={suggestions}
          onSave={(next) => save({ ...rules, commands: next })}
          onDismiss={dismiss}
        />
      ) : null}
      {error ? (
        <p className="wf-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
