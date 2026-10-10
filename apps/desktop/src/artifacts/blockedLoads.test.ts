// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_BLOCKED_LOAD_MESSAGE_TYPE,
  ARTIFACT_BLOCKED_LOAD_SCRIPT,
  addBlockedLoad,
  blockedLoadKind,
  groupBlockedLoads,
  parseArtifactBlockedLoadMessage,
  type BlockedLoad,
} from './blockedLoads';

/// Runs the in-frame reporter against a fake document and parent.
function frame() {
  let listener: ((e: Record<string, unknown>) => void) | null = null;
  const posted: Array<Record<string, unknown>> = [];
  const document = {
    addEventListener: (type: string, fn: (e: Record<string, unknown>) => void) => {
      if (type === 'securitypolicyviolation') listener = fn;
    },
  };
  const parent = { postMessage: (data: Record<string, unknown>) => posted.push(data) };
  new Function('document', 'parent', ARTIFACT_BLOCKED_LOAD_SCRIPT)(document, parent);
  const violate = (effectiveDirective: string, blockedURI: string) => listener?.({ effectiveDirective, blockedURI });
  return { posted, violate };
}

describe('blocked load reporter script', () => {
  it('posts each blocked https origin once per directive', () => {
    const f = frame();
    f.violate('script-src-elem', 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js');
    f.violate('script-src-elem', 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js');
    f.violate('img-src', 'https://upload.wikimedia.org/a.png');
    f.violate('img-src', 'https://cdnjs.cloudflare.com/x.png');
    expect(f.posted).toEqual([
      { type: ARTIFACT_BLOCKED_LOAD_MESSAGE_TYPE, directive: 'script-src-elem', origin: 'https://cdnjs.cloudflare.com' },
      { type: ARTIFACT_BLOCKED_LOAD_MESSAGE_TYPE, directive: 'img-src', origin: 'https://upload.wikimedia.org' },
      { type: ARTIFACT_BLOCKED_LOAD_MESSAGE_TYPE, directive: 'img-src', origin: 'https://cdnjs.cloudflare.com' },
    ]);
  });

  it('ignores what full web access would not open', () => {
    const f = frame();
    f.violate('script-src-elem', 'inline');
    f.violate('script-src', 'eval');
    f.violate('img-src', 'data');
    f.violate('img-src', 'http://192.168.1.10/cam.jpg');
    f.violate('connect-src', 'ws://localhost:9000');
    expect(f.posted).toEqual([]);
  });

  it('stops after twenty reports', () => {
    const f = frame();
    for (let i = 0; i < 40; i++) f.violate('img-src', `https://img${i}.example.com/a.png`);
    expect(f.posted).toHaveLength(20);
  });
});

describe('parseArtifactBlockedLoadMessage', () => {
  const msg = (directive: unknown, origin: unknown) => ({ type: ARTIFACT_BLOCKED_LOAD_MESSAGE_TYPE, directive, origin });

  it('maps directives to what the reader sees', () => {
    expect(parseArtifactBlockedLoadMessage(msg('script-src-elem', 'https://cdn.jsdelivr.net'))).toEqual({
      kind: 'scripts',
      origin: 'https://cdn.jsdelivr.net',
    });
    expect(parseArtifactBlockedLoadMessage(msg('connect-src', 'wss://stream.example.com'))?.kind).toBe('connections');
    expect(blockedLoadKind('style-src-attr')).toBe('styles');
    expect(blockedLoadKind('worker-src')).toBe('scripts');
    expect(blockedLoadKind('frame-src')).toBe('frames');
    expect(blockedLoadKind('object-src')).toBeNull();
    expect(blockedLoadKind('form-action')).toBeNull();
  });

  it('normalises the origin and refuses anything else', () => {
    expect(parseArtifactBlockedLoadMessage(msg('img-src', 'https://Upload.Wikimedia.org:443'))?.origin).toBe(
      'https://upload.wikimedia.org',
    );
    for (const bad of [
      null,
      'text',
      { type: 'other', directive: 'img-src', origin: 'https://x.example' },
      msg('img-src', 'http://x.example'),
      msg('img-src', 'javascript:alert(1)'),
      msg('img-src', 'https://user:pw@x.example'),
      msg('img-src', `https://${'a'.repeat(400)}.example`),
      msg('object-src', 'https://x.example'),
      msg(1, 'https://x.example'),
    ]) {
      expect(parseArtifactBlockedLoadMessage(bad)).toBeNull();
    }
  });
});

describe('blocked load list', () => {
  const load = (kind: BlockedLoad['kind'], origin: string): BlockedLoad => ({ kind, origin });

  it('dedupes and caps', () => {
    let list: readonly BlockedLoad[] = [];
    list = addBlockedLoad(list, load('scripts', 'https://a.example'));
    const same = addBlockedLoad(list, load('scripts', 'https://a.example'));
    expect(same).toBe(list);
    list = addBlockedLoad(list, load('images', 'https://a.example'), 2);
    expect(addBlockedLoad(list, load('fonts', 'https://b.example'), 2)).toBe(list);
  });

  it('groups hosts by kind in a stable order', () => {
    expect(
      groupBlockedLoads([
        load('images', 'https://upload.wikimedia.org'),
        load('scripts', 'https://cdnjs.cloudflare.com'),
        load('images', 'https://tile.openstreetmap.org'),
      ]),
    ).toEqual([
      { kind: 'scripts', hosts: ['cdnjs.cloudflare.com'] },
      { kind: 'images', hosts: ['upload.wikimedia.org', 'tile.openstreetmap.org'] },
    ]);
  });
});
