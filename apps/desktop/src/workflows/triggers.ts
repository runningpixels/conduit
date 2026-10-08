/// How a workflow's trigger reads on screen: what it watches, what started a
/// run, and the two things that depend on the backend's wiring (a trigger's
/// live watch status, and revealing an exported file). Those two are single
/// functions so connecting them is one line each.

import type { Translate } from '../i18n';
import { getWorkflowSchedule, revealExportedFile as revealExportedFileCommand } from '../ipc/client';
import type { WorkflowRun, WorkflowTrigger } from '../ipc/contracts';

/// What the backend knows about a trigger that is switched on.
export interface WatchStatus {
  /// Why polling stopped after repeated failures ("The feed could not be reached"); absent while it works.
  pausedReason?: string | null;
}

/// The watch status of a triggered workflow, or `null` when it isn't watching.
export async function loadWatchStatus(workflowId: string): Promise<WatchStatus | null> {
  const schedule = await getWorkflowSchedule(workflowId);
  return schedule?.watch ? { pausedReason: schedule.watch.pausedReason } : null;
}

/// Show an exported file in the system file manager (its folder, with the
/// file in it). The backend only reveals paths inside the exports folder.
export async function revealExportedFile(path: string): Promise<void> {
  await revealExportedFileCommand(path);
}

/// The host of a feed address ("blog.rust-lang.org"), or the address itself when it isn't one.
export function feedHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/// "Watching blog.rust-lang.org every 30 min" / "Watching <folder>".
export function watchingText(trigger: WorkflowTrigger, folder: string | undefined, t: Translate): string {
  return trigger.kind === 'feed'
    ? t('workspace.workflows.trigger.watchingFeed', { host: feedHost(trigger.url), count: trigger.everyMinutes })
    : t('workspace.workflows.trigger.watchingFolder', { folder: folder ?? '' });
}

/// What started a run that a trigger began: "New post: Title", "New file: name".
/// `null` for manual and scheduled runs. A trigger run whose item isn't known
/// still reads "New post" / "New file".
export function runTriggerLabel(run: Pick<WorkflowRun, 'trigger' | 'triggerItem'>, t: Translate): string | null {
  if (run.trigger === 'feed') {
    const title = run.triggerItem?.title?.trim();
    return title ? t('workspace.workflows.trigger.runFeed', { title }) : t('workspace.workflows.trigger.runFeedPlain');
  }
  if (run.trigger === 'folder') {
    const name = run.triggerItem?.name?.trim();
    return name ? t('workspace.workflows.trigger.runFolder', { name }) : t('workspace.workflows.trigger.runFolderPlain');
  }
  return null;
}
