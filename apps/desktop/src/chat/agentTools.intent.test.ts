import { describe, expect, it } from 'vitest';
import {
  DECK_TOOL_NAMES,
  builtinToolDefinitions,
  isDeckTool,
  isDocumentContentTool,
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
    // + patch_document + read_document + generate_image + 10 deck tools.
    expect(builtinToolDefinitions()).toHaveLength(36);
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
