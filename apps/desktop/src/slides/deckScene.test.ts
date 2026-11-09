import { describe, expect, it, vi } from 'vitest';
import { parseDeckEvent } from './deckDocument';
import { DECK_SCENE_SCRIPT } from './deckScene';
import { captureDeckScene, registerDeckScene } from './deckSceneBus';

interface SceneApi {
  rgba: (v: string) => number[] | null;
  layers: (v: string) => Array<{ type: string; args: string[] }> | null;
  stops: (args: string[], length: number) => Array<{ pos: number; c: number[] }>;
}

const scene = new Function(`${DECK_SCENE_SCRIPT}; return conduitScene;`)() as SceneApi;

describe('deck scene script', () => {
  it('reads computed colours and refuses what is not one', () => {
    expect(scene.rgba('rgb(255, 122, 89)')).toEqual([255, 122, 89, 1]);
    expect(scene.rgba('rgba(0, 0, 0, 0.25)')).toEqual([0, 0, 0, 0.25]);
    expect(scene.rgba('transparent')).toEqual([0, 0, 0, 0]);
    expect(scene.rgba('1100px')).toBeNull();
  });

  it('splits background layers, skipping none and refusing images', () => {
    const l = scene.layers(
      'radial-gradient(1100px 700px at 100% 0%, rgba(255, 122, 89, 0.16), rgba(0, 0, 0, 0) 60%), linear-gradient(160deg, rgb(27, 30, 42), rgb(20, 22, 31)), none',
    );
    expect(l?.map((x) => x.type)).toEqual(['radial', 'linear']);
    expect(l?.[0].args[0]).toBe('1100px 700px at 100% 0%');
    expect(scene.layers('none')).toEqual([]);
    expect(scene.layers('url("x.png")')).toBeNull();
  });

  it('places colour stops the CSS way and fades transparent stops in their neighbour', () => {
    const s = scene.stops(['rgb(255, 0, 0)', 'rgb(0, 0, 255)', 'rgba(0, 0, 0, 0) 100%'], 100);
    expect(s.map((x) => x.pos)).toEqual([0, 0.5, 1]);
    expect(s[2].c).toEqual([0, 0, 255, 0]);
    expect(scene.stops(['rgb(0, 0, 0) 20px', 'rgb(255, 255, 255)'], 200)[0].pos).toBeCloseTo(0.1);
  });
});

describe('scene plumbing', () => {
  it('parses a scene reply by shape only', () => {
    const ok = parseDeckEvent({
      type: 'conduit-deck-event',
      event: 'scene',
      requestId: 'r',
      slides: [{ id: 'a', bg: '#000000ff', bgSvg: null, items: [] }],
    });
    expect(ok).toEqual({ event: 'scene', requestId: 'r', slides: [{ id: 'a', bg: '#000000ff', bgSvg: null, items: [] }] });
    expect(parseDeckEvent({ type: 'conduit-deck-event', event: 'scene', requestId: 'r', slides: [{ items: [] }] })).toBeNull();
  });

  it('asks the frame showing the deck, and gives null without one or on failure', async () => {
    expect(await captureDeckScene('d1')).toBeNull();
    const source = vi.fn().mockResolvedValue([{ id: 'a', bg: '#fff', bgSvg: null, items: [] }]);
    const off = registerDeckScene('d1', source);
    expect(await captureDeckScene('d1', 50)).toHaveLength(1);
    expect(source).toHaveBeenCalledWith(50);
    // A stale frame unregistering doesn't remove a newer one.
    const off2 = registerDeckScene('d1', vi.fn().mockRejectedValue(new Error('gone')));
    off();
    expect(await captureDeckScene('d1')).toBeNull();
    off2();
    expect(await captureDeckScene('d1')).toBeNull();
  });
});
