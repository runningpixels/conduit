import type { ArtifactKind } from '../ipc/contracts';
import { failedDocumentToolCalls } from '../chat/agentTools';
import type { AssistantStreamState } from '../chat/streamState';

/** In-flight document tool create/edit shown in the artifact panel. */
export interface PendingArtifact {
  kind: ArtifactKind;
  title?: string;
  toolName: string;
  mode: 'create' | 'edit';
  artifactId?: string;
  /** `failed` freezes the panel on an explanation instead of a live skeleton.
   *  Absent means `generating`. */
  status?: 'generating' | 'failed';
  /** Why the generation stopped, shown on `status: 'failed'`. */
  error?: string;
}

/**
 * What the panel should show once a turn ended without a successful document
 * write. A pending artifact left as-is keeps shimmering forever — the turn is
 * the only thing that ever resolves it — so this returns either an explained
 * failure or nothing at all.
 *
 * `null` means there is nothing to explain: no document tool failed and the
 * turn itself did not error, so the model simply chose not to write one.
 */
export function resolveFailedPendingArtifact(
  current: PendingArtifact | null,
  state: AssistantStreamState,
): PendingArtifact | null {
  if (!current) return null;
  const toolError = failedDocumentToolCalls(state)
    .map((tc) => tc.error)
    .find((e): e is string => typeof e === 'string' && e.trim() !== '');
  // The turn error covers the case where the tool never reported at all — a
  // wall-clock timeout mid-write leaves no per-call failure behind.
  const reason = toolError ?? state.error;
  return reason ? { ...current, status: 'failed', error: reason } : null;
}
