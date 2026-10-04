import { describe, expect, it } from 'vitest';
import {
  DECK_TOOL_NAMES,
  DRAFT_TOOL_NAMES,
  builtinToolDefinitions,
  isDeckTool,
  isDraftTool,
  isDraftWriteTool,
  selectBuiltinDraftTools,
  isDocumentContentTool,
  looksLikeDeckRequest,
  selectBuiltinBrandTools,
  selectBuiltinDeckTools,
  selectBuiltinDocumentTools,
  selectBuiltinMemoryTools,
  selectBuiltinTurnTools,
} from './agentTools';

describe('selectBuiltinDocumentTools', () => {
  it('exposes utility tools for info or general turns', () => {
    const tools = selectBuiltinDocumentTools('info');
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('current_time');
    expect(names).toContain('uuid');
    expect(names).toContain('random');
    expect(names).toContain('calculator');
    expect(names).not.toContain('write_html_document');
    expect(names).not.toContain('edit_html_document');
    expect(names).not.toContain('patch_document');

    const generalTools = selectBuiltinDocumentTools('general');
    const generalNames = generalTools.map((tool) => tool.name);
    expect(generalNames).toContain('current_time');
    expect(generalNames).not.toContain('write_html_document');
  });

  it('exposes write + edit + utility tools for create intent', () => {
    const tools = selectBuiltinDocumentTools('create');
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('write_html_document');
    expect(names).toContain('write_markdown_document');
    expect(names).toContain('write_text_document');
    expect(names).toContain('edit_html_document');
    expect(names).toContain('edit_markdown_document');
    expect(names).toContain('patch_document');
    expect(names).toContain('read_document');
    expect(names).toContain('edit_text_document');
    expect(names).toContain('export_document');
    expect(names).toContain('current_time');
    expect(names).toContain('calculator');
  });

  it('exposes edit + utility tools for edit intent', () => {
    const tools = selectBuiltinDocumentTools('edit');
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('patch_document');
    expect(names).toContain('read_document');
    expect(names).not.toContain('write_html_document');
    expect(names).toContain('edit_html_document');
    expect(names).toContain('edit_markdown_document');
    expect(names).toContain('edit_text_document');
    expect(names).toContain('export_document');
    expect(names).toContain('current_time');
  });

  it('keeps the full catalog available for reference', () => {
    // 15 pre-Phase-4 tools + write_brand_theme + 5 workspace tools + ask_user + remember
    // + patch_document + read_document + generate_image + 10 deck tools + start_deck
    // + 5 draft tools.
    expect(builtinToolDefinitions()).toHaveLength(42);
  });

  it('offers the deck tools by stage and never through the other selectors', () => {
    const names = (stage: 'storyline' | 'slides') => selectBuiltinDeckTools(stage).map((t) => t.name);
    expect(names('storyline')).toEqual(['read_deck', 'set_storyline']);
    expect(names('slides')).toEqual([
      'read_deck',
      'set_storyline',
      'add_slide',
      'update_slide',
      'patch_slide',
      'move_slide',
      'delete_slide',
      'set_theme',
      'replace_in_deck',
      'update_slots',
    ]);
    expect([...DECK_TOOL_NAMES].sort()).toEqual([...names('slides')].sort());
    for (const name of DECK_TOOL_NAMES) {
      expect(isDeckTool(name)).toBe(true);
      expect(isDocumentContentTool(name)).toBe(false);
    }
    expect(isDeckTool('write_html_document')).toBe(false);
    expect(isDeckTool('calculator')).toBe(false);

    const everyOther = [
      ...selectBuiltinDocumentTools('create'),
      ...selectBuiltinDocumentTools('edit'),
      ...selectBuiltinBrandTools(true),
      ...selectBuiltinTurnTools(
        'write a report and draw an image',
        { workspaceToolsEnabled: true, workspaceRoot: '/w', workspaceToolsConsentAcknowledged: true, memoryEnabled: true },
        '/w',
      ).tools,
    ].map((t) => t.name);
    expect(everyOther.filter(isDeckTool)).toEqual([]);
  });

  it('advertises remember only when memory injection is on', () => {
    expect(selectBuiltinMemoryTools(false)).toEqual([]);
    expect(selectBuiltinMemoryTools(true).map((t) => t.name)).toEqual(['remember']);
    expect(selectBuiltinDocumentTools('general').map((t) => t.name)).not.toContain('remember');
  });
});

describe('start_deck gating', () => {
  const settings = { memoryEnabled: false };
  const names = (prompt: string, deckStage?: 'storyline' | 'slides' | null) =>
    selectBuiltinTurnTools(prompt, settings, null, undefined, undefined, deckStage).tools.map((t) => t.name);

  it('recognises deck requests', () => {
    for (const prompt of [
      'make me a slide deck about Q3',
      'Can you build slides for the kickoff?',
      'I need a presentation for Monday',
      'a pitch deck for investors',
      'draft a keynote',
      'PowerPoint on onboarding',
    ]) {
      expect(looksLikeDeckRequest(prompt), prompt).toBe(true);
    }
    for (const prompt of ['write a report on solar power', 'what is a deckhand', 'hello']) {
      expect(looksLikeDeckRequest(prompt), prompt).toBe(false);
    }
  });

  it('offers start_deck on a deck-request turn and drops the document write tools', () => {
    const turn = names('make me a slide deck about our Q3 results');
    expect(turn).toContain('start_deck');
    expect(turn.filter((n) => n.startsWith('write_') || n.startsWith('edit_'))).toEqual([]);
  });

  it('does not offer start_deck on other turns or in a deck chat', () => {
    expect(names('write a report on solar power')).not.toContain('start_deck');
    expect(names('make me a slide deck', 'storyline')).not.toContain('start_deck');
    expect(names('make me a slide deck', 'slides')).not.toContain('start_deck');
    expect(DECK_TOOL_NAMES.has('start_deck')).toBe(false);
  });
});

describe('draft tools (Writing)', () => {
  const settings = {
    workspaceToolsEnabled: true,
    workspaceRoot: '/w',
    workspaceToolsConsentAcknowledged: true,
    memoryEnabled: true,
  };
  const turn = (prompt: string, draftStage: 'outline' | 'draft' | null, deckStage: 'slides' | null = null) =>
    selectBuiltinTurnTools(prompt, settings, '/w', undefined, undefined, deckStage, draftStage).tools.map((t) => t.name);

  it('offers the draft tools by stage', () => {
    const names = (stage: 'outline' | 'draft') => selectBuiltinDraftTools(stage).map((t) => t.name);
    expect(names('outline')).toEqual(['read_draft', 'set_outline']);
    expect(names('draft')).toEqual(['read_draft', 'write_section', 'edit_blocks', 'replace_in_draft']);
    expect([...DRAFT_TOOL_NAMES].sort()).toEqual(
      ['edit_blocks', 'read_draft', 'replace_in_draft', 'set_outline', 'write_section'],
    );
    for (const name of DRAFT_TOOL_NAMES) {
      expect(isDraftTool(name)).toBe(true);
      expect(isDeckTool(name)).toBe(false);
      expect(isDocumentContentTool(name)).toBe(false);
    }
    expect(isDraftWriteTool('write_section')).toBe(true);
    expect(isDraftWriteTool('read_draft')).toBe(false);
    expect(isDraftWriteTool('write_html_document')).toBe(false);
  });

  it('a draft chat gets only draft, utility, read-only workspace and memory tools', () => {
    const tools = turn('write a report with slides and draw an image of a logo', 'draft');
    expect(tools).toEqual(expect.arrayContaining(['write_section', 'edit_blocks', 'calculator', 'workspace_read', 'remember']));
    for (const name of tools) {
      expect(
        isDraftTool(name) ||
          ['current_time', 'uuid', 'random', 'calculator', 'ask_user', 'remember'].includes(name) ||
          ['workspace_read', 'workspace_glob', 'workspace_grep'].includes(name),
        name,
      ).toBe(true);
    }
    expect(tools).not.toContain('workspace_write');
    expect(tools).not.toContain('start_deck');
    expect(tools).not.toContain('set_outline');
    expect(turn('anything', 'outline')).toContain('set_outline');
    expect(turn('anything', 'outline')).not.toContain('write_section');
    // The draft branch wins over a deck stage.
    expect(turn('anything', 'draft', 'slides').filter(isDeckTool)).toEqual([]);
  });

  it('is never chosen by intent: other turns never see a draft tool', () => {
    const everyOther = [
      ...selectBuiltinDocumentTools('create'),
      ...selectBuiltinDocumentTools('edit'),
      ...selectBuiltinBrandTools(true),
      ...selectBuiltinDeckTools('slides'),
      ...turn('write a blog post draft and edit the section about outlines', null),
      ...turn('make me a slide deck', null),
      ...turn('rewrite this section', null, 'slides'),
    ].map((t) => (typeof t === 'string' ? t : t.name));
    expect(everyOther.filter(isDraftTool)).toEqual([]);
  });
});
