import { beforeEach, describe, expect, it } from 'vitest';
import { resolveCapabilities, type CapabilityInput } from './capabilities';
import { IDEAS } from './catalog';
import {
  __resetIdeaStateForTests,
  getIdeaState,
  noteFirstMessage,
  notePicked,
  observeReady,
  resetIdeaState,
  type IdeaState,
} from './ideaState';
import { forYou, ideaStatus, missingNeed, newIdeas, onboardingIdeas, spotlightIdeas, starterIdeas } from './selectIdeas';

const base: CapabilityInput['settings'] = {
  localOnly: false,
  activeProvider: 'openai',
  artifactNetworkEnabled: true,
  webSearchEnabled: true,
  workspaceToolsEnabled: true,
  workspaceToolsConsentAcknowledged: true,
};
const caps = (settings: Partial<CapabilityInput['settings']> = {}, extra: Partial<CapabilityInput> = {}) =>
  resolveCapabilities({ settings: { ...base, ...settings }, provider: { isLocal: false }, collectionCount: 1, ...extra });

const fresh = (): IdeaState => ({
  tried: [],
  pending: null,
  startsWithoutIdea: 0,
  rowHidden: false,
  seenRevision: null,
  knownReady: null,
  spotlight: [],
});

describe('resolveCapabilities', () => {
  it('is all ready for a fully set-up cloud provider', () => {
    expect(caps().status).toEqual({ network: 'ready', webSearch: 'ready', imageGen: 'ready', documents: 'ready', workspace: 'ready' });
    expect(caps().localModel).toBe(false);
  });

  it('says what can be set up, and what local-only rules out', () => {
    const anthropic = caps({ activeProvider: 'anthropic', webSearchEnabled: false, artifactNetworkEnabled: false, workspaceToolsEnabled: false }, { collectionCount: 0 });
    expect(anthropic.status).toEqual({ network: 'setup', webSearch: 'setup', imageGen: 'setup', documents: 'setup', workspace: 'setup' });
    const local = caps({ localOnly: true, activeProvider: 'ollama' }, { provider: { isLocal: true } });
    expect(local.status.network).toBe('off');
    expect(local.status.webSearch).toBe('off');
    expect(local.status.imageGen).toBe('off');
    expect(local.status.documents).toBe('ready');
    expect(local.localModel).toBe(true);
  });
});

describe('selecting ideas', () => {
  it('rates an idea by its least-ready need', () => {
    const weather = IDEAS.find((i) => i.id === 'weatherDashboard')!;
    expect(ideaStatus(weather, caps())).toBe('ready');
    expect(ideaStatus(weather, caps({ artifactNetworkEnabled: false }))).toBe('setup');
    expect(missingNeed(weather, caps({ artifactNetworkEnabled: false }))).toBe('network');
    expect(ideaStatus(weather, caps({ localOnly: true }))).toBe('off');
  });

  it('offers three starters from different categories, never an unavailable one, rotating by chat', () => {
    const local = caps({ localOnly: true, activeProvider: 'ollama' }, { provider: { isLocal: true } });
    const seen = new Set<string>();
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const picks = starterIdeas(local, fresh(), seed);
      expect(picks).toHaveLength(3);
      expect(new Set(picks.map((i) => i.category)).size).toBe(3);
      for (const idea of picks) {
        expect(ideaStatus(idea, local)).toBe('ready');
        expect(idea.size).not.toBe('long'); // local model: nothing long
        seen.add(idea.id);
      }
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('leaves tried ideas out of starters and For you', () => {
    const state = { ...fresh(), tried: ['pomodoroTimer', 'snakeGame'] };
    for (const seed of ['x', 'y', 'z']) {
      expect(starterIdeas(caps(), state, seed).map((i) => i.id)).not.toContain('pomodoroTimer');
    }
    const picks = forYou(caps(), state);
    expect(picks.map((i) => i.id)).not.toContain('snakeGame');
    expect(new Set(picks.map((i) => i.category)).size).toBe(picks.length);
  });

  it('suggests something live at the end of onboarding when it can', () => {
    expect(onboardingIdeas(caps()).map((i) => i.category)).toContain('live');
    const local = onboardingIdeas(caps({ localOnly: true, activeProvider: 'ollama' }, { provider: { isLocal: true } }));
    expect(local).toHaveLength(3);
    expect(local.every((i) => i.needs.length === 0)).toBe(true);
  });

  it('spotlights ideas for a capability, and shows new ideas only after the page was seen once', () => {
    expect(spotlightIdeas(caps(), ['imageGen']).every((i) => i.needs.includes('imageGen'))).toBe(true);
    expect(spotlightIdeas(caps(), ['imageGen']).length).toBeGreaterThan(0);
    expect(newIdeas(fresh())).toEqual([]);
    expect(newIdeas({ ...fresh(), seenRevision: 0 }).length).toBe(IDEAS.length);
  });
});

describe('idea state on this device', () => {
  beforeEach(() => __resetIdeaStateForTests());

  it('marks an idea tried when its chat is sent, and counts chats started without one', () => {
    notePicked('snakeGame');
    noteFirstMessage();
    expect(getIdeaState().tried).toEqual(['snakeGame']);
    expect(getIdeaState().pending).toBeNull();
    noteFirstMessage();
    noteFirstMessage();
    expect(getIdeaState().startsWithoutIdea).toBe(2);
    notePicked('flashcards');
    noteFirstMessage();
    expect(getIdeaState().startsWithoutIdea).toBe(0);
  });

  it('spotlights a capability that becomes ready, but not on first look', () => {
    observeReady(['webSearch']);
    expect(getIdeaState().spotlight).toEqual([]);
    observeReady(['webSearch', 'imageGen']);
    expect(getIdeaState().spotlight).toEqual(['imageGen']);
    observeReady(['webSearch']); // gone again: no longer spotlit
    expect(getIdeaState().spotlight).toEqual([]);
  });

  it('persists across reloads and resets on request', () => {
    notePicked('snakeGame');
    noteFirstMessage();
    __resetIdeaStateForTests();
    // localStorage was cleared too, so a new load starts empty…
    expect(getIdeaState().tried).toEqual([]);
    notePicked('memoryGame');
    noteFirstMessage();
    resetIdeaState();
    expect(getIdeaState().tried).toEqual([]);
  });
});
