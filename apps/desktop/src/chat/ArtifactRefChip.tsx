/// M2 — in-chat artifact affordances rendered at the end of an assistant turn:
///   * `ArtifactPromoteButton` — legacy promote button (inline blocks own promotion).
///   * `ArtifactRefChip` — a pill linking back to an artifact whose
///     `sourceMessageId` matches this message.
///   * `AssistantArtifactStrip` — shows chips for artifacts promoted from this turn.

import { useMemo } from 'react';
import { Chip } from '@conduit/ui';
import type { Artifact, ArtifactKind, FileState } from '../ipc/contracts';
import type { ArtifactCandidate } from './artifactCandidates';
import { FilePlainIcon, PlusIcon } from '../icons';

const KIND_LABEL: Record<ArtifactKind, string> = {
  markdown: 'Markdown',
  text: 'Text',
  code: 'Code',
  json: 'JSON',
  html: 'HTML',
};

const STATE_DOT_CLASS: Record<FileState, string> = {
  ok: 'dot ok',
  modified: 'dot warn',
  missing: 'dot bad',
  noFileContent: 'dot hold',
};

interface ArtifactPromoteButtonProps {
  candidate: ArtifactCandidate;
  disabled?: boolean;
  onPromote: (candidate: ArtifactCandidate) => void;
}

/** "Promote to artifact" affordance for one fenced-block candidate. */
export function ArtifactPromoteButton({ candidate, disabled, onPromote }: ArtifactPromoteButtonProps) {
  const label = candidate.info
    ? `${KIND_LABEL[candidate.kind]} · ${candidate.info.split(/\s+/)[0]}`
    : KIND_LABEL[candidate.kind];
  return (
    <button
      type="button"
      className="btn ghost artifact-promote"
      disabled={disabled}
      title={`Promote this ${KIND_LABEL[candidate.kind].toLowerCase()} block to an artifact`}
      onClick={() => onPromote(candidate)}
    >
      <PlusIcon />
      Promote {label}
    </button>
  );
}

interface ArtifactRefChipProps {
  artifact: Artifact;
  fileState?: FileState;
  onOpen: (artifactId: string) => void;
}

/** Pill linking back to an artifact promoted from this message. */
export function ArtifactRefChip({ artifact, fileState, onOpen }: ArtifactRefChipProps) {
  const title = artifact.title ?? 'Untitled artifact';
  return (
    <Chip
      role="button"
      tabIndex={0}
      className="artifact-ref-chip"
      title={`Open ${title}`}
      onClick={() => onOpen(artifact.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(artifact.id);
        }
      }}
    >
      <FilePlainIcon />
      <span className="arc-kind">{KIND_LABEL[artifact.kind] ?? artifact.kind}</span>
      <span className="arc-title">{title}</span>
      {fileState && <span className={STATE_DOT_CLASS[fileState]} aria-hidden="true" />}
    </Chip>
  );
}

interface AssistantArtifactStripProps {
  messageId: string;
  artifacts: Artifact[];
  fileStateMap?: Record<string, FileState>;
  onOpenArtifact: (artifactId: string) => void;
}

function artifactMatchesMessage(artifact: Artifact, messageId: string): boolean {
  if (artifact.sourceMessageId === messageId) return true;
  if (messageId.startsWith('assistant-') && artifact.sourceMessageId === messageId) return true;
  return false;
}

/** Reference chips for artifacts linked to this assistant turn. */
export function AssistantArtifactStrip({
  messageId,
  artifacts,
  fileStateMap,
  onOpenArtifact,
}: AssistantArtifactStripProps) {
  const promoted = useMemo(
    () => artifacts.filter((a) => artifactMatchesMessage(a, messageId)),
    [artifacts, messageId],
  );

  if (promoted.length === 0) return null;

  return (
    <div className="artifact-strip">
      {promoted.map((artifact) => (
        <ArtifactRefChip
          key={artifact.id}
          artifact={artifact}
          fileState={fileStateMap?.[artifact.id]}
          onOpen={onOpenArtifact}
        />
      ))}
    </div>
  );
}
