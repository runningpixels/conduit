import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_DEFINITIONS, selectBuiltinDocumentTools } from './agentTools';

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
    expect(names).toContain('edit_text_document');
    expect(names).toContain('export_document');
    expect(names).toContain('current_time');
    expect(names).toContain('calculator');
  });

  it('exposes edit + utility tools for edit intent', () => {
    const tools = selectBuiltinDocumentTools('edit');
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('edit_html_document');
    expect(names).toContain('edit_markdown_document');
    expect(names).toContain('edit_text_document');
    expect(names).toContain('export_document');
    expect(names).toContain('current_time');
  });

  it('keeps the full catalog available for reference', () => {
    expect(BUILTIN_TOOL_DEFINITIONS).toHaveLength(15);
  });
});
