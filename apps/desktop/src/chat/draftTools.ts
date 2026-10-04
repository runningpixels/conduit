/// Tools for a chat bound to a Writing draft. The draft tools themselves are
/// defined in `agentTools.ts` next to the deck tools; this is the renderer's
/// one entry point for choosing them.

import type { DraftStage, ToolDefinition } from '@conduit/config-schema';
import { selectBuiltinTurnTools } from './agentTools';

export {
  DRAFT_TOOL_NAMES,
  draftWebSearchAvailable,
  isDraftTool,
  isDraftWriteTool,
  selectBuiltinDraftTools,
} from './agentTools';

type TurnToolSettings = Parameters<typeof selectBuiltinTurnTools>[1];

/**
 * The built-in tools for one turn in a draft chat: utilities, read-only
 * workspace tools, memory, and the draft tools for the draft's stage. No
 * document, deck, image or brand tools: they would write outside the draft.
 * Never chosen by the intent regexes.
 *
 * `webSearch` (the draft's Sources tab) adds the local `web_search` and
 * `web_fetch` tools when web search is available in `settings`. Never the
 * provider-hosted search: its citations cannot be written into the draft.
 */
export function selectDraftTurnTools(
  settings: TurnToolSettings,
  conversationRoot: string | null | undefined,
  stage: DraftStage,
  webSearch = false,
): ToolDefinition[] {
  return selectBuiltinTurnTools('', settings, conversationRoot, undefined, undefined, null, stage, webSearch)
    .tools;
}
