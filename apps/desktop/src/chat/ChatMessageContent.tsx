import { ChatProse } from './ChatProse';

interface ChatMessageContentProps {
  content: string;
  streaming?: boolean;
}

/** Plain assistant/user message content (no stream-state citations). */
export function ChatMessageContent({ content, streaming }: ChatMessageContentProps) {
  return <ChatProse content={content} streaming={streaming} />;
}
