/// Tools for a chat bound to a Writing draft. The draft tools themselves are
/// defined in `agentTools.ts` next to the deck tools; this is the renderer's
/// one entry point for choosing them.

import type { DraftStage, ToolDefinition } from '@conduit/config-schema';
import { selectBuiltinTurnTools, selectBuiltinWebTools } from './agentTools';

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
 *
 * `webSearch` (the draft's Sources tab, already checked for availability)
 * adds the local web_search and web_fetch tools. Never the provider-hosted
 * search: its citations cannot be written into the draft.
 */
export function selectDraftTurnTools(
  settings: TurnToolSettings,
  conversationRoot: string | null | undefined,
  stage: DraftStage,
  webSearch = false,
): ToolDefinition[] {
  const tools = selectBuiltinTurnTools('', settings, conversationRoot, undefined, undefined, null, stage)
    .tools;
  // MERGE-SHIM(writing-sources): until `selectBuiltinTurnTools` takes the
  // `draftWebSearch` argument (backend branch), add the local web tools here.
  // At merge: pass `webSearch` as that argument and drop this block.
  if (!webSearch) return tools;
  const have = new Set(tools.map((tool) => tool.name));
  return [...tools, ...selectBuiltinWebTools().filter((tool) => !have.has(tool.name))];
}
