import { describe, expect, it } from 'vitest';
import { feedHost, runTriggerLabel, watchingText } from './triggers';

const t = (id: string, values?: Record<string, unknown>) => `${id.split('.').pop()} ${JSON.stringify(values)}`;

describe('triggers', () => {
  it('names the host of a feed, or the address when it is not one', () => {
    expect(feedHost('https://blog.rust-lang.org/feed.xml')).toBe('blog.rust-lang.org');
    expect(feedHost('not a url')).toBe('not a url');
  });

  it('says what a trigger watches', () => {
    expect(watchingText({ kind: 'feed', url: 'https://a.example/f.xml', everyMinutes: 30 }, undefined, t)).toBe(
      'watchingFeed {"host":"a.example","count":30}',
    );
    expect(watchingText({ kind: 'folder' }, 'E:\\inbox', t)).toBe('watchingFolder {"folder":"E:\\\\inbox"}');
  });

  it('labels runs a trigger started, and no others', () => {
    expect(runTriggerLabel({ trigger: 'feed', triggerItem: { title: 'Rust 1.90' } }, t)).toBe('runFeed {"title":"Rust 1.90"}');
    expect(runTriggerLabel({ trigger: 'feed' }, t)).toBe('runFeedPlain undefined');
    expect(runTriggerLabel({ trigger: 'folder', triggerItem: { name: 'a.pdf' } }, t)).toBe('runFolder {"name":"a.pdf"}');
    expect(runTriggerLabel({ trigger: 'folder', triggerItem: { name: ' ' } }, t)).toBe('runFolderPlain undefined');
    expect(runTriggerLabel({ trigger: 'manual', triggerItem: { title: 'Rust 1.90' } }, t)).toBe('runTest {"item":"Rust 1.90"}');
    expect(runTriggerLabel({ trigger: 'manual', triggerItem: { name: 'a.pdf' } }, t)).toBe('runTest {"item":"a.pdf"}');
    expect(runTriggerLabel({ trigger: 'manual', triggerItem: null }, t)).toBeNull();
    expect(runTriggerLabel({ trigger: 'manual' }, t)).toBeNull();
    expect(runTriggerLabel({ trigger: 'schedule' }, t)).toBeNull();
  });
});
