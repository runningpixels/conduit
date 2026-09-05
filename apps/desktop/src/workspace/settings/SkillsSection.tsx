import { useCallback, useEffect, useState } from 'react';
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

interface SkillsSectionProps {
  onStatus: (message: string) => void;
  workspaceRoot?: string | null;
}

const SOURCE_LABEL: Record<SkillSource, string> = {
  conduit: 'Conduit',
  claude: 'Claude',
  agents: 'Agents',
  brand: 'Brand',
  workspace: 'Workspace',
};

export function SkillsSection({ onStatus, workspaceRoot }: SkillsSectionProps) {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSkills(await listSkills(workspaceRoot));
    } catch (e) {
      onStatus(`Failed to load skills: ${String(e)}`);
    }
  }, [onStatus, workspaceRoot]);

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
      onStatus(`${label} failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <p className="sheet-sub" style={{ marginTop: 0 }}>
        Agent Skills are SKILL.md packages. Enable them per chat from the composer.
        Scripts are never executed.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          onClick={() => void run('Imported skill folder', importSkillFolder)}
        >
          Import folder
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => void run('Imported skill zip', importSkillZip)}
        >
          Import zip
        </button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() =>
            void run('Opened Conduit skills folder', async () => {
              await revealSkillsDir();
              return true;
            })
          }
        >
          Open Conduit folder
        </button>
      </div>
      {skills.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>
          No skills yet. Drop a valid package into the Conduit skills folder, import a
          folder or zip, or keep packages in <code>~/.claude/skills</code> — those
          list here without copying.
        </p>
      ) : (
        <ul className="skill-list">
          {skills.map((skill) => (
            <li key={skill.id} className="skill-row">
              <div className="skill-row-main">
                <div className="skill-row-title">
                  <b>{skill.name}</b>
                  <span className="skill-source">{SOURCE_LABEL[skill.source]}</span>
                  {skill.hasScripts ? <span className="skill-flag">scripts unused</span> : null}
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
                    void run(`Exported ${skill.name}`, () =>
                      exportSkillFolder(skill.id, workspaceRoot),
                    )
                  }
                >
                  Export folder
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(`Exported ${skill.name}.zip`, () =>
                      exportSkillZip(skill.id, workspaceRoot),
                    )
                  }
                >
                  Export zip
                </button>
                {skill.source === 'conduit' ? (
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`Delete Conduit skill "${skill.name}"?`)) return;
                      void run(`Deleted ${skill.name}`, async () => {
                        await deleteManagedSkill(skill.id);
                        return true;
                      });
                    }}
                  >
                    Delete
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
