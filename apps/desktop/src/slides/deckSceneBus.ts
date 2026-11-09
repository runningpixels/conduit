/// Where the PowerPoint export gets a deck's scenes: what the studio's deck
/// frame measured on each drawn slide (`deckScene.ts`). The studio stage
/// registers itself for its deck; the export asks for that deck's scenes and
/// gets null when no frame is showing it, or when the frame doesn't answer in
/// time. The backend then rebuilds those slides from their fields.

import type { SlideScene } from './deckScene';

/** One slide's scene, keyed by slide id. */
export type DeckSceneSlide = SlideScene & { id: string };

type Source = (timeoutMs: number) => Promise<DeckSceneSlide[] | null>;

const sources = new Map<string, Source>();

/** Registers the frame showing `deckId`; the returned function unregisters it. */
export function registerDeckScene(deckId: string, source: Source): () => void {
  sources.set(deckId, source);
  return () => {
    if (sources.get(deckId) === source) sources.delete(deckId);
  };
}

/** The scenes of `deckId`'s slides, or null when they can't be measured now. */
export async function captureDeckScene(deckId: string, timeoutMs = 15_000): Promise<DeckSceneSlide[] | null> {
  const source = sources.get(deckId);
  if (!source) return null;
  try {
    return await source(timeoutMs);
  } catch {
    return null;
  }
}
