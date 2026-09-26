/// Which ideas to show where. Pure: capabilities and this device's idea state
/// in, ideas out.

import type { Capabilities, CapabilityStatus } from './capabilities';
import { IDEAS, type Capability, type Idea, type IdeaCategory } from './catalog';
import type { IdeaState } from './ideaState';

/// `ready` if every need is ready; `off` if any is off here; else `setup`.
export function ideaStatus(idea: Idea, caps: Capabilities): CapabilityStatus {
  let status: CapabilityStatus = 'ready';
  for (const need of idea.needs) {
    const s = caps.status[need];
    if (s === 'off') return 'off';
    if (s === 'setup') status = 'setup';
  }
  return status;
}

/// The first need that is not ready — what the card asks the reader to set up.
export function missingNeed(idea: Idea, caps: Capabilities): Capability | null {
  return idea.needs.find((n) => caps.status[n] !== 'ready') ?? null;
}

/// Small, stable hash for rotating picks per chat.
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/// Untried first, then by category not yet tried, keeping catalog order
/// within those. Only ideas that are ready.
function rankReady(caps: Capabilities, state: IdeaState): Idea[] {
  const triedCategories = new Set(
    state.tried.map((id) => IDEAS.find((i) => i.id === id)?.category).filter(Boolean) as IdeaCategory[],
  );
  const score = (idea: Idea) =>
    (state.tried.includes(idea.id) ? 2 : 0) + (triedCategories.has(idea.category) ? 1 : 0);
  return IDEAS.filter((idea) => ideaStatus(idea, caps) === 'ready')
    .map((idea, index) => ({ idea, index }))
    .sort((a, b) => score(a.idea) - score(b.idea) || a.index - b.index)
    .map((x) => x.idea);
}

/// "For you" on the Ideas page: ready, untried, one per category first.
export function forYou(caps: Capabilities, state: IdeaState, count = 3): Idea[] {
  const out: Idea[] = [];
  const seen = new Set<IdeaCategory>();
  const ranked = rankReady(caps, state).filter((i) => !state.tried.includes(i.id));
  for (const idea of ranked) {
    if (out.length >= count) break;
    if (seen.has(idea.category)) continue;
    seen.add(idea.category);
    out.push(idea);
  }
  for (const idea of ranked) {
    if (out.length >= count) break;
    if (!out.includes(idea)) out.push(idea);
  }
  return out;
}

/// Three ideas for a new chat's empty state: ready, from different
/// categories, rotated by `seed` (the conversation id) so each new chat shows
/// a different three. A local model gets no long builds.
export function starterIdeas(caps: Capabilities, state: IdeaState, seed: string, count = 3): Idea[] {
  const pool = rankReady(caps, state).filter(
    (i) => !state.tried.includes(i.id) && !(caps.localModel && i.size === 'long'),
  );
  if (pool.length === 0) return [];
  const start = hash(seed) % pool.length;
  const rotated = [...pool.slice(start), ...pool.slice(0, start)];
  const out: Idea[] = [];
  const seen = new Set<IdeaCategory>();
  for (const idea of rotated) {
    if (out.length >= count) break;
    if (seen.has(idea.category)) continue;
    seen.add(idea.category);
    out.push(idea);
  }
  return out;
}

/// Three for the end of onboarding: something quick to build, something to
/// learn or play, and — when the setup can — something live.
export function onboardingIdeas(caps: Capabilities): Idea[] {
  const empty: IdeaState = {
    tried: [],
    pending: null,
    startsWithoutIdea: 0,
    rowHidden: false,
    seenRevision: null,
    knownReady: null,
    spotlight: [],
    chipOffers: {},
    chipUsed: [],
  };
  const ready = rankReady(caps, empty).filter((i) => !(caps.localModel && i.size === 'long'));
  const pick = (categories: IdeaCategory[]) => ready.find((i) => categories.includes(i.category));
  const picks = [pick(['make']), pick(caps.localModel ? ['play'] : ['live']), pick(['learn'])];
  const out = [...new Set(picks.filter((i): i is Idea => i != null))];
  for (const idea of ready) {
    if (out.length >= 3) break;
    if (!out.includes(idea)) out.push(idea);
  }
  return out.slice(0, 3);
}

/// Ideas that use a capability in the spotlight.
export function spotlightIdeas(caps: Capabilities, spotlight: readonly Capability[]): Idea[] {
  return IDEAS.filter(
    (idea) => idea.needs.some((n) => spotlight.includes(n)) && ideaStatus(idea, caps) === 'ready',
  );
}

/// Ideas added since the reader last opened the Ideas page.
export function newIdeas(state: IdeaState): Idea[] {
  if (state.seenRevision == null) return [];
  return IDEAS.filter((idea) => idea.addedIn > state.seenRevision!);
}
