import type { SkillSource, SkillSummary } from '../ipc/contracts';

interface ComposerSkillsProps {
  open: boolean;
  streaming: boolean;
  skills: SkillSummary[];
  enabledIds: string[];
  onClose: () => void;
  onToggle: (skillId: string, enabled: boolean) => void;
  onOpenSettings?: () => void;
}

const SOURCE_LABEL: Record<SkillSource, string> = {
  conduit: 'Conduit',
  claude: 'Claude',
  agents: 'Agents',
  brand: 'Brand',
  workspace: 'Workspace',
};

/** Per-conversation skill enablement popover (t1-4). */
export function ComposerSkills({
  open,
  streaming,
  skills,
  enabledIds,
  onClose,
  onToggle,
  onOpenSettings,
}: ComposerSkillsProps) {
  if (!open) return null;

  const enabled = new Set(enabledIds);
  const usable = skills.filter((s) => !s.parseError);

  return (
    <div id="composer-skills" role="dialog" aria-label="Skills for this chat" className="chat-settings-pop">
      <p className="chat-settings-pop-lead">
        Enabled skills inject their instructions into the next turn. Scripts are not run.
      </p>
      {usable.length === 0 ? (
        <p className="chat-settings-pop-lead">
          {skills.length === 0
            ? 'No skills discovered yet.'
            : 'Discovered packages are invalid and cannot be enabled.'}
        </p>
      ) : (
        <ul className="composer-skill-list">
          {usable.map((skill) => {
            const on = enabled.has(skill.id);
            return (
              <li key={skill.id}>
                <button
                  className="toggle"
                  type="button"
                  role="switch"
                  aria-pressed={on}
                  aria-label={`${on ? 'Disable' : 'Enable'} ${skill.name}`}
                  disabled={streaming}
                  onClick={() => onToggle(skill.id, !on)}
                />
                <span>
                  <b>{skill.name}</b>
                  <small>
                    {SOURCE_LABEL[skill.source]}
                    {skill.description ? ` · ${skill.description}` : ''}
                  </small>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="chat-settings-pop-actions">
        <button className="btn ghost" type="button" onClick={onClose}>
          Close
        </button>
        {onOpenSettings ? (
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            Manage in Settings
          </button>
        ) : null}
      </div>
    </div>
  );
}
