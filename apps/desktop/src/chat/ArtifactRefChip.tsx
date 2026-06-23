/// M2 — in-chat artifact affordances rendered at the end of an assistant turn:
///   * `ArtifactPromoteButton` — a "Promote to artifact" affordance for each
///     detected fenced-block candidate in the assistant's reply.
///   * `ArtifactRefChip` — a pill linking back to an artifact whose
///     `sourceMessageId` matches this message.
///   * `AssistantArtifactStrip` — composes the two: scans the turn's content
///     for candidates, shows a promote button for each (hidden once promoted),
///     and a chip per already-promoted artifact.
///
/// No DB writeback happens here — promotion is delegated to `onPromote` (App),
/// and the chips are derived from the conversation's artifact list filtered by
/// `sourceMessageId === messageId` (plan §3 lighter-linkage path).

import { useMemo, useState } from 'react';
import { Chip } from '@conduit/ui';
import type { Artifact, ArtifactKind, FileState } from '../ipc/contracts';
import type { ArtifactCandidate } from './artifactCandidates';
import { detectArtifactCandidates } from './artifactCandidates';
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

/** "Promote to artifact" affordance for one fenced-block candidate. Shown as a
 *  small ghost button labeled with the resolved kind + language. */
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

/** Pill linking back to an artifact promoted from this message. Reuses the
 *  `@conduit/ui` `Chip` primitive; clicking opens the artifact in the
 *  DocumentPanel. */
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
  /// The real persisted message id (used both to tag new artifacts and to match
  /// existing ones via `sourceMessageId`). For a still-streaming turn this may
  /// be the request id; affordances are hidden while streaming anyway.
  messageId: string;
  /// The conversation's artifacts (metadata-only is fine — chips need id/kind/
  /// title/sourceMessageId only).
  artifacts: Artifact[];
  /// Per-artifact file-state, for the chip state dot. Optional.
  fileStateMap?: Record<string, FileState>;
  /// The assistant turn's text content, scanned for fenced-block candidates.
  content: string;
  /// Hide promote affordances while the turn is still streaming.
  streaming?: boolean;
  onPromote: (messageId: string, candidate: ArtifactCandidate) => void | Promise<void>;
  onOpenArtifact: (artifactId: string) => void;
}

/** The promote + reference strip at the end of an assistant turn. Renders
 *  nothing when there are no candidates and no promoted artifacts. Tracks
 *  locally-promoted candidate keys so a button disappears the moment it is
 *  clicked, before the refreshed artifact list propagates back as a chip. */
export function AssistantArtifactStrip({
  messageId,
  artifacts,
  fileStateMap,
  content,
  streaming,
  onPromote,
  onOpenArtifact,
}: AssistantArtifactStripProps) {
  const [promotedKeys, setPromotedKeys] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());

  const candidates = useMemo(
    () => (streaming ? [] : detectArtifactCandidates(content)),
    [content, streaming],
  );

  const promoted = useMemo(
    () => artifacts.filter((a) => a.sourceMessageId === messageId),
    [artifacts, messageId],
  );

  // While streaming, `candidates` is empty (see the memo above), so no promote
  // buttons render; chips for previously-promoted artifacts still show.
  const visibleCandidates = candidates.filter((c) => !promotedKeys.has(c.key));
  if (visibleCandidates.length === 0 && promoted.length === 0) return null;

  async function handlePromote(candidate: ArtifactCandidate) {
    if (pending.has(candidate.key)) return;
    setPending((current) => new Set(current).add(candidate.key));
    try {
      await onPromote(messageId, candidate);
      // Success: mark as promoted so the button hides and chip shows.
      setPromotedKeys((current) => new Set(current).add(candidate.key));
    } catch {
      // Failure: allow retry by not adding to promotedKeys.
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(candidate.key);
        return next;
      });
    }
  }

  return (
    <div className="artifact-strip">
      {visibleCandidates.map((candidate) => (
        <ArtifactPromoteButton
          key={candidate.key}
          candidate={candidate}
          onPromote={handlePromote}
        />
      ))}
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