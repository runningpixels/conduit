import { useEffect, useState } from 'react';
import type { AppSettings, LibraryAgent } from '../../ipc/contracts';
import type { AgentGuardrails } from '@conduit/config-schema';
import { useT } from '../../i18n';
import { listLibraryAgents } from '../../ipc/client';

interface AgentSectionProps {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
  onStatus: (message: string) => void;
  /** Opens the Agents page (shown when there are no agents to tick yet). */
  onOpenAgents?: () => void;
}

const MIN_STEPS = 1;
const MAX_STEPS = 50;
const MIN_WALL_CLOCK_SECS = 30;
const MAX_WALL_CLOCK_SECS = 1800;
const MIN_PARALLEL_HELPERS = 1;
const MAX_PARALLEL_HELPERS = 4;
const DEFAULT_PARALLEL_HELPERS = 3;

function formatMinutes(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  if (rem === 0) return `${mins} min`;
  return `${mins} min ${rem}s`;
}

/** Agent loop guardrails: max provider rounds and wall-clock budget per turn. */
export function AgentSection({ settings, onUpdate, onStatus, onOpenAgents }: AgentSectionProps) {
  const t = useT();
  const agent = settings.agent;
  const handoffAgents = agent.handoffAgents ?? [];
  const [library, setLibrary] = useState<LibraryAgent[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => listLibraryAgents())
      .then((list) => {
        if (!cancelled) setLibrary(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setLibrary([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleHandoffAgent(id: string, on: boolean) {
    const rest = handoffAgents.filter((existing: string) => existing !== id);
    patchAgent({ handoffAgents: on ? [...rest, id] : rest });
  }

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
      <p style={{ marginBottom: 12, fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
        {t('settings.agent.intro')}
      </p>

      <div className="form-grid">
        <label htmlFor="agent-max-steps" style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-3xl)' }}>
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
          <span style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
            {t('settings.agent.maxSteps.hint', { min: MIN_STEPS, max: MAX_STEPS })}
          </span>
        </label>

        <label htmlFor="agent-wall-clock" style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-3xl)' }}>
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
          <span style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
            {t('settings.agent.wallClock.hint', {
              secs: agent.wallClockBudgetSecs,
              formatted: formatMinutes(agent.wallClockBudgetSecs),
              min: MIN_WALL_CLOCK_SECS,
              maxFormatted: formatMinutes(MAX_WALL_CLOCK_SECS),
            })}
          </span>
        </label>

        <label htmlFor="agent-parallel-helpers" style={{ display: 'grid', gap: 4, fontSize: 'var(--fs-3xl)' }}>
          {t('settings.agent.parallelHelpers.label')}
          <select
            id="agent-parallel-helpers"
            value={agent.parallelHelpers ?? DEFAULT_PARALLEL_HELPERS}
            onChange={(e) => patchAgent({ parallelHelpers: Number.parseInt(e.target.value, 10) })}
            style={{ maxWidth: 120 }}
          >
            {Array.from({ length: MAX_PARALLEL_HELPERS - MIN_PARALLEL_HELPERS + 1 }, (_, i) => MIN_PARALLEL_HELPERS + i).map(
              (n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ),
            )}
          </select>
          <span style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
            {t('settings.agent.parallelHelpers.hint')}
          </span>
        </label>

        <label
          htmlFor="agent-finish-after-document-write"
          style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 4, alignItems: 'start', fontSize: 'var(--fs-3xl)' }}
        >
          <input
            id="agent-finish-after-document-write"
            type="checkbox"
            checked={agent.finishAfterDocumentWrite ?? true}
            onChange={(e) => patchAgent({ finishAfterDocumentWrite: e.target.checked })}
          />
          <span>{t('settings.agent.finishAfterDocumentWrite.label')}</span>
          <span style={{ gridColumn: 2, fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
            {t('settings.agent.finishAfterDocumentWrite.hint')}
          </span>
        </label>
      </div>

      {library !== null && (
        <div className="form-grid" role="group" aria-labelledby="agent-handoff-title" style={{ marginTop: 16 }}>
          <div id="agent-handoff-title" style={{ fontSize: 'var(--fs-3xl)' }}>
            {t('settings.agent.handoff.title')}
          </div>
          <span style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
            {t('settings.agent.handoff.hint')}
          </span>
          {library.length === 0 ? (
            <div style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>
              {t('settings.agent.handoff.empty')}{' '}
              {onOpenAgents && (
                <button type="button" className="btn ghost" onClick={onOpenAgents}>
                  {t('settings.agent.handoff.openAgents')}
                </button>
              )}
            </div>
          ) : (
            library.map((entry) => {
              const id = entry.agent.id;
              const about = (entry.agent.instructions ?? '').trim().split(/\r?\n/, 1)[0];
              return (
                <label
                  key={id}
                  htmlFor={`agent-handoff-${id}`}
                  style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 8, rowGap: 2, alignItems: 'start', fontSize: 'var(--fs-3xl)' }}
                >
                  <input
                    id={`agent-handoff-${id}`}
                    type="checkbox"
                    checked={handoffAgents.includes(id)}
                    onChange={(e) => toggleHandoffAgent(id, e.target.checked)}
                  />
                  <span>{entry.agent.name || id}</span>
                  {about && (
                    <span style={{ gridColumn: 2, fontSize: 'var(--fs-xl)', color: 'var(--ink-2)' }}>{about}</span>
                  )}
                </label>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
