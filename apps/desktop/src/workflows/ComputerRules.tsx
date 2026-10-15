/// The "This computer" group of a workflow's permissions: which commands run
/// without asking, which always ask first, what is built in, and the rules the
/// user's own approvals suggest. Rendered by ActionRulesSection.

import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import type { CommandRuleSuggestion, WorkflowCommandRules, WorkflowComputer } from '../ipc/contracts';
import { CommandRuleList } from './CommandRuleList';

/// The protections that cannot be switched off, in the order they are listed.
const BUILT_IN = [
  'workspace.workflows.perm.builtin.delete',
  'workspace.workflows.perm.builtin.discard',
  'workspace.workflows.perm.builtin.server',
  'workspace.workflows.perm.builtin.system',
  'workspace.workflows.perm.builtin.elevate',
  'workspace.workflows.perm.builtin.shells',
  'workspace.workflows.perm.builtin.packages',
  'workspace.workflows.perm.builtin.downloads',
] as const;

export function ComputerRules({
  commands,
  computer,
  busy,
  suggestions,
  onSave,
  onDismiss,
}: {
  commands: WorkflowCommandRules;
  computer: WorkflowComputer | undefined;
  busy: boolean;
  suggestions: readonly CommandRuleSuggestion[];
  /// Saves the whole command rules; resolves `true` when the backend took them.
  onSave: (next: { allow: string[]; deny: string[] }) => Promise<boolean>;
  onDismiss: (rules: string[]) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const uses = new Map((commands.uses ?? []).map((u) => [u.rule, u] as const));
  const useNote = (rule: string): string => {
    const u = uses.get(rule);
    return u && u.count > 0
      ? t('workspace.workflows.perm.computer.used', { count: u.count, when: fmt.timeAgo(u.lastUsedAt) })
      : t('workspace.workflows.perm.computer.notUsed');
  };
  const free = computer?.editMode === 'free';
  const outside = computer?.allowOutside === true;
  const current = { allow: commands.allow, deny: commands.deny };
  return (
    <section className="grp wf-perm-group" aria-label={t('workspace.workflows.perm.computer.title')}>
      <div className="grp-label">{t('workspace.workflows.perm.computer.title')}</div>
      <p className="wf-perm-summary">
        <span>{free ? t('workspace.workflows.perm.computer.filesFree') : t('workspace.workflows.perm.computer.filesAsk')}</span>
        <span aria-hidden="true"> · </span>
        {outside ? (
          <span className="wf-perm-warn">{t('workspace.workflows.perm.notConfined')}</span>
        ) : (
          <span>{t('workspace.workflows.perm.computer.confined')}</span>
        )}
      </p>
      <p className="wf-muted">{t('workspace.workflows.commands.intro')}</p>
      {suggestions.length > 0 ? (
        <ul className="wf-perm-suggest" aria-label={t('workspace.workflows.perm.suggest.label')}>
          {suggestions.map((s) => (
            <li key={s.rule}>
              <span>{t('workspace.workflows.perm.suggest.row', { example: s.example, times: s.times })}</span>
              <span className="wf-perm-suggest-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void onSave({ ...current, allow: [...commands.allow, s.rule] })}
                >
                  {t('workspace.workflows.perm.suggest.allow', { rule: s.rule })}
                </button>
                <button type="button" className="btn ghost" onClick={() => onDismiss([s.rule])}>
                  {t('workspace.workflows.perm.notNow')}
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <CommandRuleList
        label={t('workspace.workflows.commands.allowLabel')}
        hint={t('workspace.workflows.commands.allowHint')}
        rules={commands.allow}
        note={useNote}
        busy={busy}
        error={null}
        onAdd={(rule) => onSave({ ...current, allow: [...commands.allow, rule] })}
        onRemove={(rule) => void onSave({ ...current, allow: commands.allow.filter((r) => r !== rule) })}
      />
      <CommandRuleList
        label={t('workspace.workflows.commands.denyLabel')}
        hint={t('workspace.workflows.commands.denyHint')}
        placeholder={t('settings.computer.deny.placeholder')}
        rules={commands.deny}
        busy={busy}
        error={null}
        onAdd={(rule) => onSave({ ...current, deny: [...commands.deny, rule] })}
        onRemove={(rule) => void onSave({ ...current, deny: commands.deny.filter((r) => r !== rule) })}
      />
      <details className="wf-perm-builtin">
        <summary>{t('workspace.workflows.perm.builtin.title')}</summary>
        <ul>
          {BUILT_IN.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ul>
        <p className="wf-muted">{t('workspace.workflows.perm.builtin.programs')}</p>
      </details>
    </section>
  );
}
