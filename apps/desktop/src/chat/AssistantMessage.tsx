import { useState } from 'react';
import type { AssistantStreamState } from './streamState';
import { BotGlyph, CopyIcon, CheckIcon } from '../icons';
import { ContentBlock } from './ContentBlock';
import { InterruptedBanner } from './InterruptedBanner';
import { ReasoningBlock } from './ReasoningBlock';
import { ToolCallBlock } from './ToolCallBlock';
import { UsageSummary } from './UsageSummary';

interface AssistantMessageProps {
  state: AssistantStreamState;
  modelId?: string;
}

/** v5 assistant message: av-role bot avatar, prose body with inline code chips,
 *  streaming `.active` accent bar + blinking `.cursor` caret, `enter` fade-up.
 *  Deliberate delta from the mockup: a copy affordance on assistant messages. */
export function AssistantMessage({ state, modelId }: AssistantMessageProps) {
  const [copied, setCopied] = useState(false);
  const text = state.blocks.map((b) => b.content).join('');

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
        {state.blocks.length === 0 && !state.error && state.streaming ? (
          <div className="prose">
            <p>
              <span className="cursor" />
            </p>
          </div>
        ) : (
          state.blocks.map((block) => (
            <ContentBlock key={block.blockId} block={block} streaming={state.streaming} />
          ))
        )}
        {state.toolCalls.map((toolCall) => (
          <ToolCallBlock key={toolCall.toolCallId} toolCall={toolCall} />
        ))}
        {state.error && <p className="error-text">{state.error}</p>}
        <UsageSummary usage={state.usage} />
      </div>
    </div>
  );
}