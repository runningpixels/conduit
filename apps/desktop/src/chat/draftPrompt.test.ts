import { describe, expect, it } from 'vitest';
import type { DraftDetail } from '../ipc/contracts';
import { draftDeveloperPrompt, draftSystemAppendix } from './draftPrompt';
import { selectDraftTurnTools } from './draftTools';

const markdown = '## Why\n\nWe had forty repositories and every change touched five of them, which was slow and error prone for everyone.';

const draft: DraftDetail = {
  id: 'd1',
  title: 'One repo',
  conversationId: 'c1',
  stage: 'draft',
  brief: 'A blog post for backend developers, about 1,200 words.',
  outline: [
    { heading: 'Why', intent: 'The pain of many repos', targetWords: 300 },
    { heading: 'How', intent: '', targetWords: null },
  ],
  markdown,
  blocks: [
    { id: 'b1', kind: 'heading', owner: 'ai', pinned: false, start: 0, end: 6 },
    { id: 'b2', kind: 'paragraph', owner: 'user', pinned: true, start: 8, end: markdown.length },
  ],
  words: 22,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

describe('draft prompts', () => {
  it('teaches the two stages, the draft tools and the pin rule', () => {
    const text = draftSystemAppendix();
    for (const tool of ['set_outline', 'write_section', 'more_to_write', 'edit_blocks', 'replace_in_draft', 'read_draft', 'release_pinned']) {
      expect(text).toContain(tool);
    }
    expect(text).toMatch(/pinned/i);
    expect(text).not.toContain('write_html_document');
  });

  it('describes the draft compactly: stage, brief, outline and one line per block', () => {
    const text = draftDeveloperPrompt(draft);
    expect(text).toContain('Draft "One repo" · stage: draft · 22 words.');
    expect(text).toContain('Brief: A blog post for backend developers, about 1,200 words.');
    expect(text).toContain('1. Why (~300 words) — The pain of many repos');
    expect(text).toContain('2. How');
    expect(text).toContain('b1 · ai · - · ## Why');
    const line = text.split('\n').find((l) => l.startsWith('b2 · user · pinned · '))!;
    expect(line).toBeDefined();
    // The first 80 characters of the block, no more.
    expect(line.length).toBeLessThanOrEqual('b2 · user · pinned · '.length + 80);
    expect(line.endsWith('…')).toBe(true);
  });

  it('asks for an outline first in a new draft', () => {
    const text = draftDeveloperPrompt({ ...draft, stage: 'outline', outline: [], blocks: [], markdown: '' });
    expect(text).toContain('Outline: none yet.');
    expect(text).toContain('Blocks: none yet');
    expect(text).toContain('set_outline');
  });
});

describe('selectDraftTurnTools', () => {
  it('offers no document, deck, image or brand tools in a draft chat', () => {
    const names = selectDraftTurnTools({ memoryEnabled: true }, null, 'draft').map((t) => t.name);
    expect(names).toContain('ask_user');
    for (const banned of ['write_html_document', 'write_markdown_document', 'start_deck', 'add_slide', 'read_deck', 'generate_image', 'write_brand_theme']) {
      expect(names).not.toContain(banned);
    }
  });
});
