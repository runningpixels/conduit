import type { Artifact } from '../ipc/contracts';
import type { ArtifactCandidate } from './artifactCandidates';
import { ChatProse } from './ChatProse';

interface ChatMessageContentProps {
  content: string;
  streaming?: boolean;
  messageId?: string;
  artifacts?: Artifact[];
  onPromoteArtifact?: (messageId: string, candidate: ArtifactCandidate) => void;
  onOpenArtifact?: (artifactId: string) => void;
}

/** Plain assistant/user message content (no stream-state citations). */
export function ChatMessageContent({
  content,
  streaming,
  messageId,
  artifacts,
  onPromoteArtifact,
  onOpenArtifact,
}: ChatMessageContentProps) {
  return (
    <ChatProse
      content={content}
      streaming={streaming}
      messageId={messageId}
      artifacts={artifacts}
      onPromoteArtifact={onPromoteArtifact}
      onOpenArtifact={onOpenArtifact}
    />
  );
}
