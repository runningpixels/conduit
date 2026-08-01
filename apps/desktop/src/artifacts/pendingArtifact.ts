import type { ArtifactKind } from '../ipc/contracts';

/** In-flight document tool create/edit shown in the artifact panel. */
export interface PendingArtifact {
  kind: ArtifactKind;
  title?: string;
  toolName: string;
  mode: 'create' | 'edit';
  artifactId?: string;
}
