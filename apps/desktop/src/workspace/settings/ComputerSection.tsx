import { useEffect, useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { getWorkflow, listWorkflows, updateSettings } from '../../ipc/client';
import { useT } from '../../i18n';
import { CommandRuleList, rejectionText } from '../../workflows/CommandRuleList';
import { usesComputer } from '../../workflows/editorModel';
import { folderName } from '../../workflows/WorkflowViewParts';

interface ComputerWorkflow {
  id: string;
  name: string;
  folder: string | null;
}

interface ComputerSectionProps {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
}

/**
 * Whether workflows may use this computer (run programs and change files in a
 * workflow's folder), and the commands that always ask first in every workflow.
 * Saved straight away through `update_settings` rather than the debounced
 * auto-save, because the backend refuses a deny rule it cannot parse and the
 * reason belongs next to the box where it was typed.
 */
export function ComputerSection({ settings, onUpdate }: ComputerSectionProps) {
  const t = useT();
  const enabled = settings.workflowComputer?.enabled ?? false;
  const deny = settings.workflowComputer?.deny ?? [];
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /// The workflows that give an agent the computer; null until read.
  const [workflows, setWorkflows] = useState<ComputerWorkflow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => listWorkflows())
      .then((list) => Promise.all(list.map((w) => getWorkflow(w.id).then((r) => r, () => null))))
      .then(
        (records) => {
          if (cancelled) return;
          setWorkflows(
            records
              .filter((r): r is NonNullable<typeof r> => r !== null && usesComputer(r.definition))
              .map((r) => ({ id: r.id, name: r.name, folder: folderName(r.definition.folder) })),
          );
        },
        () => {
          if (!cancelled) setWorkflows(null);
        },
      );
    return () => {
      cancelled = true;
    };
  }, []);

  async function save(next: { enabled: boolean; deny: string[] }): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      onUpdate(await updateSettings({ workflowComputer: next }));
      return true;
    } catch (e) {
      setError(rejectionText(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <p style={{ marginBottom: 12, fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>{t('settings.computer.intro')}</p>
      <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
        <li>{t('settings.computer.point.folder')}</li>
        <li>{t('settings.computer.point.asks')}</li>
        <li>{t('settings.computer.point.alwaysAsks')}</li>
        <li>{t('settings.computer.point.reach')}</li>
      </ul>
      <label
        htmlFor="workflow-computer-enabled"
        style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--fs-3xl)', marginBottom: 12 }}
      >
        <input
          id="workflow-computer-enabled"
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => void save({ enabled: e.target.checked, deny })}
        />
        <span>{t('settings.computer.enabled.label')}</span>
      </label>
      {workflows ? (
        <div className="settings-computer-workflows" style={{ marginBottom: 12, fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
          <p style={{ margin: '0 0 4px', color: 'var(--ink)' }}>{t('settings.computer.workflows.label')}</p>
          {workflows.length === 0 ? (
            <p style={{ margin: 0 }}>{t('settings.computer.workflows.none')}</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {workflows.map((w) => (
                <li key={w.id}>
                  {w.name} · {w.folder ?? t('settings.computer.workflows.noFolder')}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <CommandRuleList
        label={t('settings.computer.deny.label')}
        hint={t('settings.computer.deny.hint')}
        placeholder={t('settings.computer.deny.placeholder')}
        rules={deny}
        busy={saving}
        error={error}
        onAdd={(rule) => save({ enabled, deny: [...deny, rule] })}
        onRemove={(rule) => void save({ enabled, deny: deny.filter((r) => r !== rule) })}
      />
    </div>
  );
}
