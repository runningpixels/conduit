/// The Scheduled page's templates: a starting point for a task, with an icon, a default time and
/// instructions. They are renderer data; the words are translated (`shell.scheduled.template.*`).
/// Their instructions rely only on what a task can do: search the web, read pages and feeds, read a
/// new file in a watched folder. Nothing here needs email, a calendar or a connector.

import type { ComponentType, SVGProps } from 'react';
import type { Translate } from '../i18n';
import { ActivityCheckIcon, BrowserIcon, FolderIcon, GlobeIcon, IdeaIcon, SearchIcon } from '../icons';
import { emptyDraft, type TaskDraft } from './taskForm';
import type { TimedSpec } from './schedule';

export type TemplateId = 'dailyBriefing' | 'monitorTopic' | 'weeklyReview' | 'contentIdeas' | 'watchPage' | 'folderDigest';

export interface TaskTemplate {
  id: TemplateId;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /// When it runs unless the user changes it: a time, or each new file in a folder.
  when: { spec: TimedSpec } | { folder: true };
}

export const TEMPLATES: readonly TaskTemplate[] = [
  { id: 'dailyBriefing', Icon: GlobeIcon, when: { spec: { kind: 'weekdays', time: '08:00' } } },
  { id: 'monitorTopic', Icon: SearchIcon, when: { spec: { kind: 'daily', time: '09:00' } } },
  { id: 'weeklyReview', Icon: ActivityCheckIcon, when: { spec: { kind: 'weekly', days: ['fri'], time: '16:00' } } },
  { id: 'contentIdeas', Icon: IdeaIcon, when: { spec: { kind: 'weekly', days: ['mon'], time: '09:00' } } },
  { id: 'watchPage', Icon: BrowserIcon, when: { spec: { kind: 'daily', time: '10:00' } } },
  { id: 'folderDigest', Icon: FolderIcon, when: { folder: true } },
];

/// A template's translated name, one-line description and instructions.
export function templateText(id: TemplateId, t: Translate): { name: string; description: string; instructions: string } {
  return {
    name: t(`shell.scheduled.template.${id}.name`),
    description: t(`shell.scheduled.template.${id}.description`),
    instructions: t(`shell.scheduled.template.${id}.instructions`),
  };
}

/// The dialog's starting point for a template: its name, instructions and default time.
export function draftFromTemplate(template: TaskTemplate, t: Translate): TaskDraft {
  const text = templateText(template.id, t);
  const draft = emptyDraft();
  return 'folder' in template.when
    ? { ...draft, name: text.name, task: text.instructions, when: 'folder' }
    : { ...draft, name: text.name, task: text.instructions, when: template.when.spec.kind, spec: template.when.spec };
}
