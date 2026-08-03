import type { AppSettings } from '../../ipc/contracts';
import type { AgentGuardrails } from '@conduit/config-schema';

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
      onStatus(`Max agent steps must be between ${MIN_STEPS} and ${MAX_STEPS}.`);
      return;
    }
    patchAgent({ maxSteps: parsed });
  }

  function handleWallClockChange(raw: string) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return;
    if (parsed < MIN_WALL_CLOCK_SECS || parsed > MAX_WALL_CLOCK_SECS) {
      onStatus(
        `Turn time limit must be between ${MIN_WALL_CLOCK_SECS}s and ${MAX_WALL_CLOCK_SECS}s.`,
      );
      return;
    }
    patchAgent({ wallClockBudgetSecs: parsed });
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Agent</span>
      </div>
      <p style={{ marginBottom: 12, fontSize: '12px', color: 'var(--ink-2)' }}>
        These guardrails cap how long a single chat message can run autonomously
        when the model uses tools (web search, connectors, artifacts). Each tool
        call and follow-up counts as one step.
      </p>

      <div className="form-grid" style={{ display: 'grid', gap: 12 }}>
        <label htmlFor="agent-max-steps" style={{ display: 'grid', gap: 4, fontSize: '13px' }}>
          Max agent steps
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
            Provider rounds per message (tool calls + follow-ups). Range: {MIN_STEPS}–{MAX_STEPS}.
          </span>
        </label>

        <label htmlFor="agent-wall-clock" style={{ display: 'grid', gap: 4, fontSize: '13px' }}>
          Turn time limit (seconds)
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
            {agent.wallClockBudgetSecs}s = {formatMinutes(agent.wallClockBudgetSecs)}. Range:{' '}
            {MIN_WALL_CLOCK_SECS}s–{formatMinutes(MAX_WALL_CLOCK_SECS)}.
          </span>
        </label>
      </div>
    </div>
  );
}
