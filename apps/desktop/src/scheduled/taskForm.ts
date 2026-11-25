/// What the task dialog edits (`TaskDraft`), what it sends (`taskRequest`), and where a draft comes
/// from: a template, or a task that already exists (read back from its workflow).

import type {
  RoutineOutput,
  RoutineRequest,
  ScheduledItem,
  ScheduleSpec,
  WorkflowModel,
  WorkflowRecord,
} from '../ipc/contracts';
import { DEFAULT_TIME, specForKind, type TimedSpec, type WhenKind } from './schedule';

/// Most words, and characters, of a name made from the task.
const NAME_FROM_TASK_WORDS = 6;
const NAME_FROM_TASK_CHARS = 60;

/// A short name for a task from its text: the first words of its first line, without trailing punctuation.
export function nameFromTask(task: string): string {
  const line = task.trim().split('\n')[0]?.trim() ?? '';
  const words = line.split(/\s+/).filter(Boolean).slice(0, NAME_FROM_TASK_WORDS).join(' ');
  const short = words.length > NAME_FROM_TASK_CHARS ? words.slice(0, NAME_FROM_TASK_CHARS) : words;
  return short.replace(/[\s.,;:!?…-]+$/u, '');
}

/// Everything the dialog's fields hold.
export interface TaskDraft {
  name: string;
  task: string;
  /// One of the user's agents (library id); empty: the assistant itself.
  agentId: string;
  model: WorkflowModel | null;
  when: WhenKind;
  /// The timed schedule the When options edit; used while `when` is a time kind.
  spec: TimedSpec;
  folder: string;
  feedUrl: string;
  output: RoutineOutput;
  notify: boolean;
}

/// A blank draft: weekdays at 08:00, the result in a chat.
export function emptyDraft(now: Date = new Date()): TaskDraft {
  return {
    name: '',
    task: '',
    agentId: '',
    model: null,
    when: 'weekdays',
    spec: specForKind('weekdays', { kind: 'daily', time: DEFAULT_TIME }, now),
    folder: '',
    feedUrl: '',
    output: 'chat',
    notify: false,
  };
}

/// What the dialog sends for `form`: a time schedule, or `{kind:'trigger'}` with the folder or feed to watch.
export function taskRequest(form: TaskDraft): RoutineRequest {
  const timed = form.when !== 'folder' && form.when !== 'feed';
  const schedule: ScheduleSpec = timed ? form.spec : { kind: 'trigger' };
  const trigger =
    form.when === 'folder'
      ? ({ kind: 'folder' } as const)
      : form.when === 'feed'
        ? ({ kind: 'feed', url: form.feedUrl.trim(), everyMinutes: 30 } as const)
        : null;
  return {
    agentId: form.agentId || null,
    model: form.model,
    name: form.name.trim() || nameFromTask(form.task),
    task: form.task.trim(),
    schedule,
    trigger,
    notify: form.notify,
    output: form.output,
    folder: form.folder.trim() || null,
  };
}

/// A draft from an existing task: what its row knows, and the output, notification, model and folder its
/// workflow's steps say.
export function draftFromTask(item: ScheduledItem, record: WorkflowRecord | null): TaskDraft {
  const draft = emptyDraft();
  const steps = record?.definition.steps ?? [];
  const work = steps.find((s) => s.type === 'agent');
  const output: RoutineOutput = steps.some((s) => s.type === 'export_file')
    ? 'file'
    : steps.some((s) => s.type === 'save_artifact')
      ? 'document'
      : 'chat';
  const spec = item.schedule && item.schedule.kind !== 'trigger' ? item.schedule : draft.spec;
  const when: WhenKind =
    item.trigger?.kind === 'folder' ? 'folder' : item.trigger?.kind === 'feed' ? 'feed' : spec.kind;
  return {
    ...draft,
    name: item.name,
    task: item.task ?? (work?.type === 'agent' ? work.prompt : ''),
    agentId: item.agentId ?? '',
    model: work?.type === 'agent' ? (work.model ?? null) : null,
    when,
    spec,
    folder: record?.definition.folder ?? '',
    feedUrl: item.trigger?.kind === 'feed' ? item.trigger.url : '',
    output,
    notify: steps.some((s) => s.type === 'notify'),
  };
}
