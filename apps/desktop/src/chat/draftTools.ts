/// Tools for a chat bound to a Writing draft. The draft tools themselves are
/// defined in `agentTools.ts` next to the deck tools; this is the renderer's
/// one entry point for choosing them.

import type { DraftStage, ToolDefinition } from '@conduit/config-schema';
import { selectBuiltinTurnTools } from './agentTools';

export {
  DRAFT_TOOL_NAMES,
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
 */
export function selectDraftTurnTools(
  settings: TurnToolSettings,
  conversationRoot: string | null | undefined,
  stage: DraftStage,
): ToolDefinition[] {
  return selectBuiltinTurnTools('', settings, conversationRoot, undefined, undefined, null, stage)
    .tools;
}
