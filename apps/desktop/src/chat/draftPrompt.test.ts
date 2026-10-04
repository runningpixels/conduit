import { describe, expect, it } from 'vitest';
import type { DraftDetail } from '../ipc/contracts';
import { DRAFT_NO_INVENTION_RULE, draftDeveloperPrompt, draftResearchSection, draftSystemAppendix } from './draftPrompt';
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
    { heading: 'How', intent: '' },
  ],
  markdown,
  blocks: [
    { id: 'b1', kind: 'heading', owner: 'ai', pinned: false, start: 0, end: 6 },
    { id: 'b2', kind: 'paragraph', owner: 'user', pinned: true, start: 8, end: markdown.length },
  ],
  words: 22,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  sources: { webSearch: false, researchRunIds: [] },
};

describe('draft prompts', () => {
  it('teaches the two stages, the draft tools and the pin rule', () => {
    const text = draftSystemAppendix();
    for (const tool of ['set_outline', 'write_section', 'edit_blocks', 'replace_in_draft', 'read_draft', 'release_pinned']) {
      expect(text).toContain(tool);
    }
    expect(text).toMatch(/pinned/i);
    expect(text).not.toContain('write_html_document');
  });

  it('asks for one section per response and never mentions more_to_write', () => {
    const text = draftSystemAppendix({ webSearch: true, documents: true });
    expect(text).toContain('Write one section per response: call write_section once, then stop; you will be asked for the next.');
    expect(text).not.toContain('more_to_write');
  });

  it('adds a rule per source, and always the no-invention rule', () => {
    const none = draftSystemAppendix();
    expect(none).toContain(DRAFT_NO_INVENTION_RULE);
    expect(none).toContain('[TODO: …]');
    expect(none).not.toContain('web_search');
    expect(none).not.toContain("Passages from the user's documents");

    const web = draftSystemAppendix({ webSearch: true });
    expect(web).toContain('Look things up with web_search/web_fetch when a fact needs it.');
    expect(web).toContain('[text](url)');
    expect(web).not.toContain("Passages from the user's documents");

    const docs = draftSystemAppendix({ documents: true });
    expect(docs).toContain("when you use one, name the document in parentheses");
    expect(docs).not.toContain('web_search');
    expect(docs).toContain(DRAFT_NO_INVENTION_RULE);
  });

  it('lists research material as verified facts with ids, titles and urls', () => {
    const material = [
      {
        runId: 'r1',
        question: 'How fast do monorepos build?',
        truncated: false,
        claims: [
          { id: 'R1.1', claim: 'Builds  got\n40% faster.', sourceTitle: 'Build report', url: 'https://example.com/a' },
          { id: 'R1.2', claim: 'CI cost fell.', url: 'https://ci.example.org/b' },
        ],
      },
      { runId: 'r2', question: 'Empty', truncated: false, claims: [] },
    ];
    const section = draftResearchSection(material);
    expect(section).toContain('Verified facts from research reports');
    expect(section).toContain('Report: How fast do monorepos build?');
    expect(section).toContain('R1.1 · Builds got 40% faster. · Build report · https://example.com/a');
    // No title: the host stands in.
    expect(section).toContain('R1.2 · CI cost fell. · ci.example.org · https://ci.example.org/b');
    expect(section).toContain('Prefer these facts; cite each one you use with an inline link to its URL. They were checked against their sources.');
    expect(section).not.toContain('Report: Empty');
    expect(section).not.toContain('left out');
    expect(draftResearchSection([{ ...material[0], truncated: true }])).toContain('Some claims were left out');
    expect(draftResearchSection([])).toBe('');
    expect(draftResearchSection(null)).toBe('');

    expect(draftDeveloperPrompt(draft, material)).toContain('R1.1 · Builds got 40% faster.');
    expect(draftDeveloperPrompt(draft)).not.toContain('Verified facts');
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
  it('adds the local web tools only when the draft uses web search', () => {
    const off = selectDraftTurnTools({ memoryEnabled: true }, null, 'draft').map((t) => t.name);
    expect(off).not.toContain('web_search');
    expect(off).not.toContain('web_fetch');
    const on = selectDraftTurnTools({ memoryEnabled: true }, null, 'draft', true).map((t) => t.name);
    expect(on).toContain('web_search');
    expect(on).toContain('web_fetch');
    expect(on).toContain('write_section');
    expect(new Set(on).size).toBe(on.length);
  });

  it('offers no document, deck, image or brand tools in a draft chat', () => {
    const names = selectDraftTurnTools({ memoryEnabled: true }, null, 'draft').map((t) => t.name);
    expect(names).toContain('ask_user');
    for (const banned of ['write_html_document', 'write_markdown_document', 'start_deck', 'add_slide', 'read_deck', 'generate_image', 'write_brand_theme']) {
      expect(names).not.toContain(banned);
    }
  });
});
