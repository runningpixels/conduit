import { useCallback, useEffect, useState } from 'react';
import { appName } from '../../brand';
import type { SkillSource, SkillSummary } from '../../ipc/contracts';
import {
  deleteManagedSkill,
  exportSkillFolder,
  exportSkillZip,
  importSkillFolder,
  importSkillZip,
  listSkills,
  revealSkillsDir,
} from '../../ipc/client';
import { useRichT, useT, type Translate } from '../../i18n';

interface SkillsSectionProps {
  onStatus: (message: string) => void;
  workspaceRoot?: string | null;
}

function sourceLabel(source: SkillSource, t: Translate): string {
  switch (source) {
    case 'conduit':
      return appName();
    case 'claude':
      return 'Claude';
    case 'agents':
      return t('settings.skills.source.agents');
    case 'brand':
      return t('settings.skills.source.brand');
    case 'workspace':
      return t('settings.skills.source.workspace');
  }
}

export function SkillsSection({ onStatus, workspaceRoot }: SkillsSectionProps) {
  const t = useT();
  const tr = useRichT();
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSkills(await listSkills(workspaceRoot));
    } catch (e) {
      onStatus(t('settings.skills.status.loadFailed', { error: String(e) }));
    }
  }, [onStatus, workspaceRoot, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(true);
    try {
      const result = await action();
      if (result !== null && result !== undefined) {
        onStatus(label);
      }
      await refresh();
    } catch (e) {
      onStatus(t('settings.skills.status.actionFailed', { label, error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <p className="sheet-sub" style={{ marginTop: 0 }}>
        {t('settings.skills.intro')}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          onClick={() => void run(t('settings.skills.status.importedFolder'), importSkillFolder)}
        >
          {t('settings.skills.actions.importFolder')}
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => void run(t('settings.skills.status.importedZip'), importSkillZip)}
        >
          {t('settings.skills.actions.importZip')}
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() =>
            void run(t('settings.skills.status.openedFolder'), async () => {
              await revealSkillsDir();
              return true;
            })
          }
        >
          {t('settings.skills.actions.openFolder')}
        </button>
      </div>
      {skills.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>{tr('settings.skills.empty.hint')}</p>
      ) : (
        <ul className="skill-list">
          {skills.map((skill) => (
            <li key={skill.id} className="skill-row">
              <div className="skill-row-main">
                <div className="skill-row-title">
                  <b>{skill.name}</b>
                  <span className="skill-source">{sourceLabel(skill.source, t)}</span>
                  {skill.hasScripts ? <span className="skill-flag">{t('settings.skills.scriptsUnusedFlag')}</span> : null}
                </div>
                {skill.parseError ? (
                  <small className="skill-error">{skill.parseError}</small>
                ) : (
                  <small>{skill.description}</small>
                )}
              </div>
              <div className="skill-row-actions">
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(t('settings.skills.status.exported', { name: skill.name }), () =>
                      exportSkillFolder(skill.id, workspaceRoot),
                    )
                  }
                >
                  {t('settings.skills.actions.exportFolder')}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(t('settings.skills.status.exportedZip', { name: skill.name }), () =>
                      exportSkillZip(skill.id, workspaceRoot),
                    )
                  }
                >
                  {t('settings.skills.actions.exportZip')}
                </button>
                {skill.source === 'conduit' ? (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(t('settings.skills.confirm.delete', { name: skill.name }))) return;
                      void run(t('settings.skills.status.deleted', { name: skill.name }), async () => {
                        await deleteManagedSkill(skill.id);
                        return true;
                      });
                    }}
                  >
                    {t('common.actions.delete')}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
