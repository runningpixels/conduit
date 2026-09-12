import type { AppSettings } from '../../ipc/contracts';
import type { AgentGuardrails } from '@conduit/config-schema';
import { useT } from '../../i18n';

interface AgentSectionProps {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}

const MIN_STEPS = 1;
const MAX_STEPS = 50;
const MIN_WALL_CLOCK_SECS = 30;
const MAX_WALL_CLOCK_SECS = 1800;

function formatMinutes(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (rem === 0) return `${mins} min`;
  return `${mins} min ${rem}s`;
}

/** Agent loop guardrails: max provider rounds and wall-clock budget per turn. */
export function AgentSection({ settings, onUpdate, onStatus }: AgentSectionProps) {
  const t = useT();
  const agent = settings.agent;

  function patchAgent(next: Partial<AgentGuardrails>) {
    onUpdate({
      ...settings,
      agent: { ...agent, ...next },
    });
  }

  function handleMaxStepsChange(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    if (parsed < MIN_STEPS || parsed > MAX_STEPS) {
      onStatus(t('settings.agent.status.maxStepsRange', { min: MIN_STEPS, max: MAX_STEPS }));
      return;
    }
    patchAgent({ maxSteps: parsed });
  }

  function handleWallClockChange(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    if (parsed < MIN_WALL_CLOCK_SECS || parsed > MAX_WALL_CLOCK_SECS) {
      onStatus(
        t('settings.agent.status.wallClockRange', {
          min: MIN_WALL_CLOCK_SECS,
          max: MAX_WALL_CLOCK_SECS,
        }),
      );
      return;
    }
    patchAgent({ wallClockBudgetSecs: parsed });
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>{t('settings.agent.header.title')}</span>
      </div>
      <p style={{ marginBottom: 12, fontSize: '12px', color: 'var(--ink-2)' }}>
        {t('settings.agent.intro')}
      </p>

      <div className="form-grid">
        <label htmlFor="agent-max-steps" style={{ display: 'grid', gap: 4, fontSize: '13px' }}>
          {t('settings.agent.maxSteps.label')}
          <input
            id="agent-max-steps"
            type="number"
            min={MIN_STEPS}
            max={MAX_STEPS}
            step={1}
            value={agent.maxSteps}
            onChange={(e) => handleMaxStepsChange(e.target.value)}
            style={{ maxWidth: 120 }}
          />
          <span style={{ fontSize: '12px', color: 'var(--ink-2)' }}>
            {t('settings.agent.maxSteps.hint', { min: MIN_STEPS, max: MAX_STEPS })}
          </span>
        </label>

        <label htmlFor="agent-wall-clock" style={{ display: 'grid', gap: 4, fontSize: '13px' }}>
          {t('settings.agent.wallClock.label')}
          <input
            id="agent-wall-clock"
            type="number"
            min={MIN_WALL_CLOCK_SECS}
            max={MAX_WALL_CLOCK_SECS}
            step={30}
            value={agent.wallClockBudgetSecs}
            onChange={(e) => handleWallClockChange(e.target.value)}
            style={{ maxWidth: 120 }}
          />
          <span style={{ fontSize: '12px', color: 'var(--ink-2)' }}>
            {t('settings.agent.wallClock.hint', {
              secs: agent.wallClockBudgetSecs,
              formatted: formatMinutes(agent.wallClockBudgetSecs),
              min: MIN_WALL_CLOCK_SECS,
              maxFormatted: formatMinutes(MAX_WALL_CLOCK_SECS),
            })}
          </span>
        </label>
      </div>
    </div>
  );
}
