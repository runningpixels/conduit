/// Small parts of an open workflow's page: the summary chips under the name,
/// the Steps / Runs / Results tabs and the "More" menu.

import { useRef, useState } from 'react';
import { useT } from '../i18n';
import { Menu } from '../workspace/Menu';
import type { WorkflowDefinition } from '../ipc/contracts';
import { formatNextRun } from './ScheduleSection';
import { useFormatters } from '../i18n/formatters';

export type WorkflowTab = 'steps' | 'runs' | 'results' | 'permissions';

const TAB_ORDER: WorkflowTab[] = ['steps', 'runs', 'results', 'permissions'];

export const tabButtonId = (tab: WorkflowTab) => `wfv-tab-${tab}`;
export const tabPanelId = (tab: WorkflowTab) => `wfv-panel-${tab}`;

/** The last segment of a folder path, whichever way it is written. */
export function folderName(path: string | undefined): string | null {
  const last = (path ?? '').split(/[\\/]/).filter(Boolean).at(-1);
  return last ?? null;
}

function Chip({ label, value, onClick }: { label: string; value: string; onClick?: () => void }) {
  const body = (
    <>
      <span className="wfv-chip-label">{label}</span>{' '}
      <span className="wfv-chip-value" title={value}>
        {value}
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className="wfv-chip is-action" onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className="wfv-chip">{body}</span>
  );
}

/** What starts the workflow, what it asks for, which model and which folder. */
export function SummaryChips({
  definition,
  nextRunAt,
  onOpenStart,
  computer,
}: {
  definition: WorkflowDefinition;
  nextRunAt: string | null | undefined;
  /** Show the Start node (its values and schedule) in the Steps tab. */
  onOpenStart: () => void;
  /** The workflow uses the computer: how many commands run without asking (null until known), and a way to the Permissions tab. */
  computer?: { rules: number | null; onOpen: () => void };
}) {
  const t = useT();
  const fmt = useFormatters();
  const trigger = definition.trigger;
  const next = nextRunAt
    ? t('workspace.workflows.list.nextRun', {
        when: formatNextRun(nextRunAt, fmt.locale),
      })
    : null;
  const starts =
    trigger?.kind === 'feed'
      ? t('workspace.workflows.view.startsFeed')
      : trigger?.kind === 'folder'
        ? t('workspace.workflows.view.startsFolder')
        : trigger?.kind === 'connector'
          ? t('workspace.workflows.view.startsConnector')
          : (next ?? t('workspace.workflows.view.startsManual'));
  const startsValue = trigger && next ? `${starts} · ${next}` : starts;
  const inputs = (definition.inputs ?? []).map((i) => i.label).filter(Boolean);
  return (
    <div className="wfv-chips">
      <Chip label={t('workspace.workflows.view.chipStarts')} value={startsValue} onClick={onOpenStart} />
      {inputs.length > 0 ? <Chip label={t('workspace.workflows.view.chipAsks')} value={inputs.join(', ')} onClick={onOpenStart} /> : null}
      <Chip label={t('workspace.workflows.view.chipModel')} value={definition.model?.model || t('workspace.workflows.view.modelChat')} />
      <Chip label={t('workspace.workflows.view.chipFolder')} value={folderName(definition.folder) ?? t('workspace.workflows.view.folderNone')} />
      {computer ? (
        <Chip
          label={t('workspace.workflows.view.chipComputer')}
          value={computer.rules === null ? t('workspace.workflows.perm.tab') : t('workspace.workflows.view.computerRules', { count: computer.rules })}
          onClick={computer.onOpen}
        />
      ) : null}
      {computer && definition.computer?.allowOutside === true ? (
        <button type="button" className="wfv-chip is-action wfv-chip-warn" onClick={computer.onOpen}>
          {t('workspace.workflows.perm.notConfined')}
        </button>
      ) : null}
    </div>
  );
}

/** The tab strip; the page renders the panel it controls. */
export function WorkflowTabs({
  tab,
  onTab,
  runCount,
  resultCount,
  showPermissions = false,
  notConfined = false,
}: {
  tab: WorkflowTab;
  onTab: (tab: WorkflowTab) => void;
  runCount: number;
  resultCount: number;
  /** The workflow uses the computer or a connector that acts: it has permissions to show. */
  showPermissions?: boolean;
  /** Commands may leave the folder: the tab carries a warning. */
  notConfined?: boolean;
}) {
  const t = useT();
  const order = showPermissions ? TAB_ORDER : TAB_ORDER.filter((id) => id !== 'permissions');
  const label = (id: WorkflowTab) =>
    id === 'steps'
      ? t('workspace.workflows.steps.title')
      : id === 'runs'
        ? runCount > 0
          ? t('workspace.workflows.view.tabRunsCount', { count: runCount })
          : t('workspace.workflows.view.tabRuns')
        : id === 'permissions'
          ? t('workspace.workflows.perm.tab')
          : resultCount > 0
            ? t('workspace.workflows.results.tabResultsCount', {
                count: resultCount,
              })
            : t('workspace.workflows.results.tabResults');
  return (
    <div className="wfv-tabs" role="tablist" aria-label={t('workspace.workflows.view.tabsLabel')}>
      {order.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={tabButtonId(id)}
          aria-selected={tab === id}
          aria-controls={tabPanelId(id)}
          tabIndex={tab === id ? 0 : -1}
          className={`wfv-tab${tab === id ? ' is-active' : ''}`}
          onClick={() => onTab(id)}
          onKeyDown={(e) => {
            const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const next = order[(order.indexOf(id) + step + order.length) % order.length];
            onTab(next);
            document.getElementById(tabButtonId(next))?.focus();
          }}
        >
          {label(id)}
          {id === 'permissions' && notConfined ? (
            <span className="wfv-tab-warn" role="img" aria-label={t('workspace.workflows.perm.notConfined')} title={t('workspace.workflows.perm.notConfined')}>
              !
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** "···": the actions that are not part of the everyday set (Delete). */
export function MoreMenu({ deleteDisabled, onDelete }: { deleteDisabled: boolean; onDelete: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <div className="wfv-more">
      <button
        ref={button}
        type="button"
        className="btn ghost wfv-more-btn"
        aria-label={t('workspace.workflows.view.more')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden="true">···</span>
      </button>
      <Menu open={open} onClose={() => setOpen(false)} triggerRef={button} className="wfv-menu" label={t('workspace.workflows.view.more')} dismissOnOutsidePress>
        <button
          type="button"
          role="menuitem"
          className="wfv-menu-item"
          disabled={deleteDisabled}
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
        >
          {t('common.actions.delete')}
        </button>
      </Menu>
    </div>
  );
}
