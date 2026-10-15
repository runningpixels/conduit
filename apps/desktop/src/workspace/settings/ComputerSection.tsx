import { useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { updateSettings } from '../../ipc/client';
import { useT } from '../../i18n';
import { CommandRuleList, rejectionText } from '../../workflows/CommandRuleList';

interface ComputerSectionProps {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
}

/**
 * Whether workflows may use this computer (run programs and change files in a
 * workflow's folder), and the global deny rules that win over every allow rule.
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
      <div className="settings-section-header">
        <span>{t('settings.computer.header.title')}</span>
      </div>
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
      <CommandRuleList
        label={t('settings.computer.deny.label')}
        hint={t('settings.computer.deny.hint')}
        rules={deny}
        busy={saving}
        error={error}
        onAdd={(rule) => save({ enabled, deny: [...deny, rule] })}
        onRemove={(rule) => void save({ enabled, deny: deny.filter((r) => r !== rule) })}
      />
    </div>
  );
}
