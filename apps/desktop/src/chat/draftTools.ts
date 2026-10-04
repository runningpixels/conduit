/// Tools for a chat bound to a Writing draft.
///
/// TEMPORARY STUB (feat/writing-ui): `selectBuiltinDraftTools` belongs in
/// `agentTools.ts`, where the backend branch (feat/writing) defines the draft
/// tools next to the deck tools. Until the two branches merge it returns no
/// tools. At merge, delete the stub below and import `selectBuiltinDraftTools`
/// from `./agentTools` instead; nothing else here changes.

import type { DraftStage, ToolDefinition } from '@conduit/config-schema';
import { isDeckTool, selectBuiltinTurnTools } from './agentTools';

/** TEMPORARY STUB: replaced at merge by `selectBuiltinDraftTools` from `./agentTools`. */
export function selectBuiltinDraftTools(_stage: DraftStage): ToolDefinition[] {
  return [];
}

/** The draft tools (contract: docs/private/writing-contract.md, "Model tools"). */
export const DRAFT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'read_draft',
  'set_outline',
  'write_section',
  'edit_blocks',
  'replace_in_draft',
]);

/** The one draft tool that never changes the draft. */
export const READ_DRAFT_TOOL_NAME = 'read_draft';

export function isDraftTool(name: string): boolean {
  return DRAFT_TOOL_NAMES.has(name);
}

/** A draft tool whose success means the draft changed (everything but read_draft). */
export function isDraftWriteTool(name: string): boolean {
  return isDraftTool(name) && name !== READ_DRAFT_TOOL_NAME;
}

type TurnToolSettings = Parameters<typeof selectBuiltinTurnTools>[1];

/**
 * The built-in tools for one turn in a draft chat: utilities, read-only
 * workspace tools and memory (exactly what a deck chat gets, minus the deck
 * tools), plus the draft tools for the draft's stage. No document, deck,
 * image or brand tools: they would write outside the draft. Never chosen by
 * the intent regexes.
 */
export function selectDraftTurnTools(
  settings: TurnToolSettings,
  conversationRoot: string | null | undefined,
  stage: DraftStage,
): ToolDefinition[] {
  // The deck branch of selectBuiltinTurnTools is the "bound chat" set; its
  // stage only decides which deck tools come along, and those are dropped.
  const { tools } = selectBuiltinTurnTools('', settings, conversationRoot, undefined, undefined, 'storyline');
  return [...tools.filter((tool) => !isDeckTool(tool.name)), ...selectBuiltinDraftTools(stage)];
}
