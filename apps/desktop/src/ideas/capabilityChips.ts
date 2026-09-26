/// One follow-up chip that points at something the reply did not use, when
/// the reply fits it (docs/plans/ideas-and-discovery.md, "the right idea at
/// the right moment"). Tied to what just happened, never to a timer; at most
/// one per reply; a chip offered `CHIP_GIVE_UP` times without use stops.

import { CHIP_GIVE_UP, type IdeaState } from './ideaState';

export type CapabilityChipId = 'liveData' | 'dashboard' | 'flashcards';

export interface CapabilityChipContext {
  /// The HTML of a page artifact in scope, if the reply made or edited one.
  pageHtml: string | null;
  /// The text of another kind of document in scope (markdown, code…), if any.
  otherArtifactText: string | null;
  lastUser: string;
  lastAssistant: string;
  /// Pages can reach the internet (ADR-010).
  networkReady: boolean;
  state: Pick<IdeaState, 'chipOffers' | 'chipUsed'>;
}

const LIVE_TOPIC = /\b(weather|forecast|price|prices|rate|rates|exchange|stock|stocks|crypto|score|scores|news|stats|statistics|population|repo|repositories|followers)\b/i;
const TABLE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/m;

function offered(id: CapabilityChipId, state: CapabilityChipContext['state']): boolean {
  return state.chipUsed.includes(id) || (state.chipOffers[id] ?? 0) < CHIP_GIVE_UP;
}

export function capabilityChip(ctx: CapabilityChipContext): CapabilityChipId | null {
  const { pageHtml, otherArtifactText, lastUser, lastAssistant, networkReady, state } = ctx;
  if (pageHtml != null) {
    // A page about something live that does not fetch it yet.
    if (
      networkReady &&
      !/\bfetch\s*\(/.test(pageHtml) &&
      (LIVE_TOPIC.test(pageHtml.slice(0, 20000)) || LIVE_TOPIC.test(lastUser)) &&
      offered('liveData', state)
    ) {
      return 'liveData';
    }
    return null;
  }
  // A document that is a table (a reply promoted to Markdown, say): a dashboard.
  if (otherArtifactText != null) {
    return TABLE.test(otherArtifactText) && offered('dashboard', state) ? 'dashboard' : null;
  }
  if (!lastAssistant) return null;
  // Numbers in a table, or a lot of them: that is a dashboard.
  const numbers = lastAssistant.match(/\b\d[\d,.]*%?/g)?.length ?? 0;
  if ((TABLE.test(lastAssistant) || numbers >= 8) && offered('dashboard', state)) return 'dashboard';
  // A long explanation: something to study.
  if (lastAssistant.length > 900 && /\?\s*$/.test(lastUser.trim()) && offered('flashcards', state)) {
    return 'flashcards';
  }
  return null;
}
