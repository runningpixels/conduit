import type { ToolCallState } from './streamState';

/** True when a tool call is a hosted `web_search` call. The adapter tags
 *  these with `tool_id = "web_search"` regardless of the provider. */
export function isWebSearchToolCall(toolCall: ToolCallState): boolean {
  return toolCall.toolId === 'web_search' || toolCall.name === 'web_search';
}
