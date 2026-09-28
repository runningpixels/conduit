import { describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_EXTENSIONS, knowledgeDropPaths, routeNativeDrop } from './useKnowledgeDrop';

describe('knowledgeDropPaths', () => {
  it('keeps the formats the knowledge base can read, in drop order', () => {
    expect(
      knowledgeDropPaths([
        'C:\\Users\\me\\report.PDF',
        '/home/me/photo.png',
        '/home/me/notes.md',
        'C:\\Users\\me\\data.csv',
        '/home/me/archive.zip',
      ]),
    ).toEqual(['C:\\Users\\me\\report.PDF', '/home/me/notes.md', 'C:\\Users\\me\\data.csv']);
  });

  it('ignores files with no extension rather than guessing', () => {
    expect(knowledgeDropPaths(['/home/me/README', '/home/me/.bashrc'])).toEqual([]);
  });

  /** The Rust picker filter and this list must agree, or a file could be
   *  droppable but not pickable (or the reverse). */
  it('matches the extensions the Rust file picker offers', () => {
    expect(KNOWLEDGE_EXTENSIONS).toEqual(['txt', 'md', 'markdown', 'mdown', 'text', 'csv', 'docx', 'pdf']);
  });
});

/** t1-8 M1, D13: the window drop router. A composer drop never reaches
 *  Documents, and a drop elsewhere never attaches. */
describe('routeNativeDrop', () => {
  it('a composer drop never reaches Documents', () => {
    const onDrop = vi.fn();
    const onComposerDrop = vi.fn();
    routeNativeDrop(['C:\\notes\\report.md'], true, onDrop, onComposerDrop);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onComposerDrop).toHaveBeenCalledWith(['C:\\notes\\report.md']);
  });

  it('a thread (non-composer) drop never attaches', () => {
    const onDrop = vi.fn();
    const onComposerDrop = vi.fn();
    routeNativeDrop(['C:\\notes\\report.md'], false, onDrop, onComposerDrop);
    expect(onComposerDrop).not.toHaveBeenCalled();
    expect(onDrop).toHaveBeenCalledWith(['C:\\notes\\report.md']);
  });

  it('a composer drop is not filtered to knowledge-base extensions -- the composer takes any file', () => {
    const onDrop = vi.fn();
    const onComposerDrop = vi.fn();
    routeNativeDrop(['C:\\pics\\photo.png'], true, onDrop, onComposerDrop);
    expect(onComposerDrop).toHaveBeenCalledWith(['C:\\pics\\photo.png']);
  });

  it('a thread drop of a file the knowledge base cannot read calls neither handler', () => {
    const onDrop = vi.fn();
    const onComposerDrop = vi.fn();
    routeNativeDrop(['C:\\archive.zip'], false, onDrop, onComposerDrop);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onComposerDrop).not.toHaveBeenCalled();
  });

  it('a composer drop with no onComposerDrop wired is a no-op, not a fall-through to Documents', () => {
    const onDrop = vi.fn();
    routeNativeDrop(['C:\\notes\\report.md'], true, onDrop, undefined);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('an empty composer drop calls nothing', () => {
    const onDrop = vi.fn();
    const onComposerDrop = vi.fn();
    routeNativeDrop([], true, onDrop, onComposerDrop);
    expect(onComposerDrop).not.toHaveBeenCalled();
  });
});
