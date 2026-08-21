import {
  checkArtifactFileState,
  listArtifacts,
} from '../ipc/client';
import type { Artifact, FileState } from '../ipc/contracts';

export interface ArtifactListSnapshot {
  artifacts: Artifact[];
  fileStateMap: Record<string, FileState>;
}

/**
 * Load artifacts for a conversation plus per-artifact file-state.
 * Used by App to keep rail/document state in sync after opens, saves, and promotes.
 */
export async function refreshArtifactList(conversationId: string): Promise<ArtifactListSnapshot> {
  const listed = await listArtifacts(conversationId);
  const states = await Promise.all(
    listed.map(async (a) => {
      try {
        return [a.id, await checkArtifactFileState(a.id)] as const;
      } catch {
        return [a.id, 'missing' as FileState] as const;
      }
    }),
  );
  return {
    artifacts: listed,
    fileStateMap: Object.fromEntries(states),
  };
}
