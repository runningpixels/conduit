import { useState } from 'react';
import { ReasoningBlock } from './ReasoningBlock';
import { ChatProse } from './ChatProse';
import type { AssistantStreamState } from './streamState';
import type { Artifact, FileState } from '../ipc/contracts';
import type { ArtifactCandidate } from './artifactCandidates';
import { BotGlyph, CopyIcon, CheckIcon } from '../icons';
import { InterruptedBanner } from './InterruptedBanner';
import { ToolCallBlock } from './ToolCallBlock';
import { SearchCallGroup } from './SearchCallGroup';
import { isWebSearchToolCall } from './SearchCallBlock';
import { UsageSummary } from './UsageSummary';
import { AssistantArtifactStrip } from './ArtifactRefChip';

interface AssistantMessageProps {
  state: AssistantStreamState;
  modelId?: string;
  /// Real persisted message id (for artifact linkage). Absent for the
  /// still-streaming live message — the strip hides promote affordances then.
  messageId?: string;
  /// Conversation artifacts, for the in-chat reference chips.
  artifacts?: Artifact[];
  /// Per-artifact file-state, for the chip state dots.
  fileStateMap?: Record<string, FileState>;
  /// Promote a detected fenced-block candidate to an artifact (App handles the
  /// create + setContent + open flow).
  onPromoteArtifact?: (messageId: string, candidate: ArtifactCandidate) => void;
  /// Open an existing artifact in the DocumentPanel (chip click).
  onOpenArtifact?: (artifactId: string) => void;
}

/** v5 assistant message: av-role bot avatar, prose body with inline code chips,
 *  streaming `.active` accent bar + blinking `.cursor` caret, `enter` fade-up.
 *  Deliberate delta from the mockup: a copy affordance on assistant messages. */
export function AssistantMessage({
  state,
  modelId,
  messageId,
  artifacts,
  fileStateMap,
  onPromoteArtifact,
  onOpenArtifact,
}: AssistantMessageProps) {
  const [copied, setCopied] = useState(false);
  const text = state.blocks.map((b) => b.content).join('');
  const webSearchCalls = state.toolCalls.filter(isWebSearchToolCall);
  const otherToolCalls = state.toolCalls.filter((tc) => !isWebSearchToolCall(tc));

  async function handleCopy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be unavailable; fail silently */
    }
  }

  return (
    <div className={`msg${state.streaming ? ' active enter' : ' enter'}`}>
      <div className="av-role bot">
        <BotGlyph />
      </div>
      <div className="msg-body">
        <div className="msg-from">
          <b>Assistant</b>
          {modelId && <span className="model">{modelId}</span>}
          <div className="msg-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label={copied ? 'Copied' : 'Copy message'}
              title={copied ? 'Copied' : 'Copy message'}
              onClick={handleCopy}
              disabled={!text}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          </div>
        </div>
        <InterruptedBanner visible={state.interrupted} />
        {state.reasoning.map((block) => (
          <ReasoningBlock key={block.blockId} block={block} />
        ))}
        {webSearchCalls.length > 0 && (
          <SearchCallGroup
            toolCalls={webSearchCalls}
            unavailable={state.searchUnavailable}
            cost={state.searchCost}
          />
        )}
        {state.blocks.length > 0 ? (
          state.blocks.map((block) => (
            <ChatProse
              key={block.blockId}
              content={block.content}
              citations={block.citations}
              streaming={state.streaming}
            />
          ))
        ) : (
          <ChatProse content={text} streaming={state.streaming} />
        )}
        {otherToolCalls.map((toolCall) => (
          <ToolCallBlock key={toolCall.toolCallId} toolCall={toolCall} />
        ))}
        {state.error && <p className="error-text">{state.error}</p>}
        <UsageSummary usage={state.usage} searchCost={state.searchCost} />
        {messageId && onPromoteArtifact && onOpenArtifact && (
          <AssistantArtifactStrip
            messageId={messageId}
            artifacts={artifacts ?? []}
            fileStateMap={fileStateMap}
            content={text}
            streaming={state.streaming}
            onPromote={onPromoteArtifact}
            onOpenArtifact={onOpenArtifact}
          />
        )}
      </div>
    </div>
  );
}
