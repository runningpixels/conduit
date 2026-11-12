import { useEffect, useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import {
  browserRememberedSites,
  getWorkflow,
  listBrowsers,
  listWorkflows,
  resetBrowserProfile,
  updateSettings,
  type BrowserInfo,
} from '../../ipc/client';
import { translateError } from '../../ipc/errors';
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
  const browser = settings.workflowComputer?.browser;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /// The browsers found on this machine; null until read.
  const [browsers, setBrowsers] = useState<BrowserInfo[] | null>(null);
  const [resetting, setResetting] = useState(false);
  const [browserNote, setBrowserNote] = useState<{ text: string; failed: boolean } | null>(null);
  /// Hosts the agents' browser has cookies for; empty when none or when they can't be read.
  const [sites, setSites] = useState<string[]>([]);
  /// Bumped after a profile reset so the sites are read again.
  const [sitesKey, setSitesKey] = useState(0);
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

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => listBrowsers())
      .then(
        (list) => {
          if (!cancelled) setBrowsers(list ?? []);
        },
        () => {
          if (!cancelled) setBrowsers([]);
        },
      );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => browserRememberedSites())
      .then(
        (list) => {
          if (!cancelled) setSites(Array.isArray(list) ? list : []);
        },
        () => {
          if (!cancelled) setSites([]);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [sitesKey]);

  /// Saves the computer settings. The browser choice rides along unless `next` names a new one
  /// (`null` for Automatic), so changing the switch or the rules never drops it.
  async function save(next: { enabled: boolean; deny: string[]; browser?: string | null }): Promise<boolean> {
    setSaving(true);
    setError(null);
    try {
      const chosen = next.browser === undefined ? browser : next.browser;
      const workflowComputer = { enabled: next.enabled, deny: next.deny, ...(chosen ? { browser: chosen } : {}) };
      onUpdate(await updateSettings({ workflowComputer }));
      return true;
    } catch (e) {
      setError(rejectionText(e));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function resetProfile() {
    setResetting(true);
    setBrowserNote(null);
    try {
      await resetBrowserProfile();
      setBrowserNote({ text: t('settings.computer.browser.resetDone'), failed: false });
    } catch (e) {
      setBrowserNote({ text: translateError(e, t), failed: true });
    } finally {
      setResetting(false);
      setSitesKey((k) => k + 1);
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
      <div className="srow">
        <span className="srow-text">
          <b>{t('settings.computer.browser.label')}</b>
          <small>{t('settings.computer.browser.help')}</small>
        </span>
        <select
          className="sel"
          aria-label={t('settings.computer.browser.label')}
          value={browser ?? ''}
          disabled={saving}
          onChange={(e) => void save({ enabled, deny, browser: e.target.value || null })}
        >
          <option value="">{t('settings.computer.browser.automatic')}</option>
          {(browsers ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
          {browser && !(browsers ?? []).some((b) => b.id === browser) ? <option value={browser}>{browser}</option> : null}
        </select>
      </div>
      {browsers && browsers.length === 0 ? (
        <p className="wf-muted" style={{ margin: '0 0 12px' }}>
          {t('settings.computer.browser.none')}
        </p>
      ) : null}
      {sites.length > 0 ? (
        <p className="wf-muted settings-browser-sites" style={{ margin: '0 0 12px' }}>
          {t('settings.computer.browser.sites', { sites: sites.join(', ') })}
        </p>
      ) : null}
      <div className="srow">
        <span className="srow-text">
          <small>{t('settings.computer.browser.resetHelp')}</small>
        </span>
        <button type="button" className="btn ghost" disabled={resetting} onClick={() => void resetProfile()}>
          {t('settings.computer.browser.reset')}
        </button>
      </div>
      {browserNote ? (
        <p
          role="status"
          className={browserNote.failed ? 'wf-error' : 'wf-muted'}
          style={{ margin: '0 0 12px' }}
        >
          {browserNote.text}
        </p>
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
