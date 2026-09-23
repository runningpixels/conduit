import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_EXTENSIONS, knowledgeDropPaths } from './useKnowledgeDrop';

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
