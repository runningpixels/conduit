/// "This workflow asked you N times. Allow these from now on?": shown beside
/// the latest run once it has finished, when the commands the user approved by
/// hand fit a few rules. Everything is ticked; the user unticks what should
/// keep asking. "Not now" is remembered for this workflow.

import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { setWorkflowActionRules } from '../ipc/client';
import type { WorkflowActionRules } from '../ipc/contracts';
import { rejectionText } from './CommandRuleList';
import { useRuleSuggestions } from './useActionRules';

export function RuleSuggestionsBanner({
  workflowId,
  rules,
  runKey,
  enabled,
  onRules,
}: {
  workflowId: string;
  /// The stored rules; null until read (nothing is suggested then).
  rules: WorkflowActionRules | null;
  /// Changes when a run ends.
  runKey: unknown;
  /// A finished run exists and nothing is running.
  enabled: boolean;
  onRules: (next: WorkflowActionRules) => void;
}) {
  const t = useT();
  const allowed = rules?.commands?.allow ?? [];
  const { suggestions, dismiss } = useRuleSuggestions(workflowId, enabled && rules !== null, runKey, allowed);
  const [unticked, setUnticked] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setUnticked([]);
    setError(null);
  }, [workflowId, runKey]);

  if (!rules || suggestions.length === 0) return null;
  const chosen = suggestions.filter((s) => !unticked.includes(s.rule));
  const asked = suggestions.reduce((sum, s) => sum + s.times, 0);

  const allow = async () => {
    setSaving(true);
    setError(null);
    try {
      const commands = rules.commands ?? { allow: [], deny: [] };
      const next: WorkflowActionRules = {
        ...rules,
        commands: { allow: [...commands.allow, ...chosen.map((s) => s.rule)], deny: commands.deny },
      };
      onRules(await setWorkflowActionRules(workflowId, next));
      // What was left unticked was a no: don't offer it again.
      dismiss(suggestions.filter((s) => unticked.includes(s.rule)).map((s) => s.rule));
    } catch (e) {
      setError(rejectionText(e) || t('workspace.workflows.outside.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="wfv-section wf-learn" aria-label={t('workspace.workflows.perm.learn.label')}>
      <p className="wf-learn-title">{t('workspace.workflows.perm.learn.title', { count: asked })}</p>
      <ul className="wf-learn-list">
        {suggestions.map((s) => (
          <li key={s.rule}>
            <label className="wf-check">
              <input
                type="checkbox"
                checked={!unticked.includes(s.rule)}
                disabled={saving}
                onChange={(e) => setUnticked(e.target.checked ? unticked.filter((r) => r !== s.rule) : [...unticked, s.rule])}
              />
              <span>
                <code>{s.rule}</code>
                <span className="wf-muted"> {t('workspace.workflows.perm.learn.times', { times: s.times, example: s.example })}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="wf-learn-actions">
        <button type="button" className="btn primary" disabled={saving || chosen.length === 0} onClick={() => void allow()}>
          {t('workspace.workflows.perm.learn.allow')}
        </button>
        <button type="button" className="btn ghost" disabled={saving} onClick={() => dismiss(suggestions.map((s) => s.rule))}>
          {t('workspace.workflows.perm.notNow')}
        </button>
      </div>
      {error ? (
        <p className="wf-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
