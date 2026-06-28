import { describe, expect, it } from 'vitest';
import { BUILTIN_TOOL_DEFINITIONS, selectBuiltinDocumentTools } from './agentTools';

describe('selectBuiltinDocumentTools', () => {
  it('exposes write tools for create intent', () => {
    const tools = selectBuiltinDocumentTools('create');
    expect(tools.map((tool) => tool.name)).toEqual([
      'write_html_document',
      'write_markdown_document',
      'write_text_document',
      'export_document',
    ]);
  });

  it('exposes edit tools for edit intent', () => {
    const tools = selectBuiltinDocumentTools('edit');
    expect(tools.map((tool) => tool.name)).toEqual([
      'edit_html_document',
      'edit_markdown_document',
      'edit_text_document',
      'export_document',
    ]);
  });

  it('exposes no built-in document tools for info or general turns', () => {
    expect(selectBuiltinDocumentTools('info')).toEqual([]);
    expect(selectBuiltinDocumentTools('general')).toEqual([]);
  });

  it('keeps the full catalog available for reference', () => {
    expect(BUILTIN_TOOL_DEFINITIONS).toHaveLength(7);
  });
});
