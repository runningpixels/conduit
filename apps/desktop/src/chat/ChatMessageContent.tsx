import type { Artifact, FileState } from '../ipc/contracts';
import type { ArtifactCandidate } from './artifactCandidates';
import { ChatProse } from './ChatProse';

interface ChatMessageContentProps {
  content: string;
  streaming?: boolean;
  messageId?: string;
  artifacts?: Artifact[];
  fileStateMap?: Record<string, FileState>;
  onPromoteArtifact?: (messageId: string, candidate: ArtifactCandidate) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onStatus?: (message: string) => void;
}

/** Plain assistant/user message content (no stream-state citations). */
export function ChatMessageContent({
  content,
  streaming,
  messageId,
  artifacts,
  fileStateMap,
  onPromoteArtifact,
  onOpenArtifact,
  onStatus,
}: ChatMessageContentProps) {
  return (
    <ChatProse
      content={content}
      streaming={streaming}
      messageId={messageId}
      artifacts={artifacts}
      fileStateMap={fileStateMap}
      onPromoteArtifact={onPromoteArtifact}
      onOpenArtifact={onOpenArtifact}
      onStatus={onStatus}
    />
  );
}
