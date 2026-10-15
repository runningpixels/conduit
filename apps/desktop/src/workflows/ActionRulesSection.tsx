/// "Outside actions" for a saved workflow: which steps that send, post or
/// change something through a connector go ahead without asking. By default a
/// run stops before each one and shows exactly what it will do; the user can
/// allow single actions from that prompt ("Don't ask again for this in this
/// workflow") and takes them back here. Sensitive actions always ask.
///
/// Shown only when the workflow has a step that can act, or when its rules
/// are not the default, so they can still be reset.

import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { getWorkflowActionRules, setWorkflowActionRules } from '../ipc/client';
import type { WorkflowActionRules, WorkflowStep } from '../ipc/contracts';
import { CommandRuleList, rejectionText } from './CommandRuleList';
import { usesConnectorTools } from './editorModel';

function isDefault(rules: WorkflowActionRules): boolean {
  return !rules.allowAll && rules.allowed.length === 0 && !rules.commands?.allow.length && !rules.commands?.deny.length;
}

export function ActionRulesSection({
  workflowId,
  steps,
  usesComputer = false,
}: {
  workflowId: string;
  steps: readonly WorkflowStep[];
  /// An agent or helper of this workflow uses the computer, so command rules matter.
  usesComputer?: boolean;
}) {
  const t = useT();
  const [rules, setRules] = useState<WorkflowActionRules | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRules(null);
    setError(null);
    Promise.resolve()
      .then(() => getWorkflowActionRules(workflowId))
      .then(
        (next) => {
          if (!cancelled) setRules(next);
        },
        () => {
          // Nothing saved yet reads as the default; a failed read hides the section.
          if (!cancelled) setRules(null);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  if (!rules) return null;
  const connectors = usesConnectorTools(steps);
  if (!connectors && !usesComputer && isDefault(rules)) return null;
  const commands = rules.commands ?? { allow: [], deny: [] };
  const showCommands = usesComputer || commands.allow.length > 0 || commands.deny.length > 0;

  const save = async (next: WorkflowActionRules): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      setRules(await setWorkflowActionRules(workflowId, next));
      return true;
    } catch (e) {
      setError(rejectionText(e) || t('workspace.workflows.outside.saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const saveCommands = (next: { allow: string[]; deny: string[] }) => save({ ...rules, commands: next });

  return (
    <section className="grp wf-actions" aria-label={t('workspace.workflows.outside.title')}>
      <div className="grp-label">{t('workspace.workflows.outside.title')}</div>
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
      {showCommands ? (
        <div className="wf-commands">
          <p className="wf-muted">{t('workspace.workflows.commands.intro')}</p>
          <CommandRuleList
            label={t('workspace.workflows.commands.allowLabel')}
            hint={t('workspace.workflows.commands.allowHint')}
            rules={commands.allow}
            busy={saving}
            error={null}
            onAdd={(rule) => saveCommands({ ...commands, allow: [...commands.allow, rule] })}
            onRemove={(rule) => void saveCommands({ ...commands, allow: commands.allow.filter((r) => r !== rule) })}
          />
          <CommandRuleList
            label={t('workspace.workflows.commands.denyLabel')}
            hint={t('workspace.workflows.commands.denyHint')}
            rules={commands.deny}
            busy={saving}
            error={null}
            onAdd={(rule) => saveCommands({ ...commands, deny: [...commands.deny, rule] })}
            onRemove={(rule) => void saveCommands({ ...commands, deny: commands.deny.filter((r) => r !== rule) })}
          />
        </div>
      ) : null}
      {error ? (
        <p className="wf-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
