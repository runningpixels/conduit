import type { ProjectSettings } from '../ipc/contracts';

/** Whether a project adds anything to its chats (a plain folder does not). */
export function projectHasSettings(project: ProjectSettings): boolean {
  return Boolean(
    project.userInstructions?.trim() ||
      project.workspaceRoot ||
      project.skillIds.length > 0 ||
      project.collectionIds.length > 0,
  );
}
