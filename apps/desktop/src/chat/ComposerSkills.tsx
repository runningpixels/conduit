import { appName } from '../brand';
import type { SkillSource, SkillSummary } from '../ipc/contracts';
import { useT, type Translate } from '../i18n';

interface ComposerSkillsProps {
  open: boolean;
  streaming: boolean;
  skills: SkillSummary[];
  enabledIds: string[];
  onClose: () => void;
  onToggle: (skillId: string, enabled: boolean) => void;
  onOpenSettings?: () => void;
}

function sourceLabel(source: SkillSource, t: Translate): string {
  switch (source) {
    case 'conduit':
      return appName();
    case 'claude':
      return 'Claude';
    case 'agents':
      return t('chat.skills.source.agents');
    case 'brand':
      return t('chat.skills.source.brand');
    case 'workspace':
      return t('chat.skills.source.workspace');
  }
}

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
  const t = useT();
  if (!open) return null;

  const enabled = new Set(enabledIds);
  const usable = skills.filter((s) => !s.parseError);

  return (
    <div id="composer-skills" role="dialog" aria-label={t('chat.skills.ariaLabel')} className="chat-settings-pop">
      <p className="chat-settings-pop-lead">
        {t('chat.skills.intro')}
      </p>
      {usable.length === 0 ? (
        <p className="chat-settings-pop-lead">
          {skills.length === 0
            ? t('chat.skills.noneDiscovered')
            : t('chat.skills.allInvalid')}
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
                  aria-label={t('chat.skills.toggleAriaLabel', {
                    action: on ? 'disable' : 'enable',
                    name: skill.name,
                  })}
                  disabled={streaming}
                  onClick={() => onToggle(skill.id, !on)}
                />
                <span>
                  <b>{skill.name}</b>
                  <small>
                    {sourceLabel(skill.source, t)}
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
          {t('common.actions.close')}
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
            {t('chat.skills.manageInSettings')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
