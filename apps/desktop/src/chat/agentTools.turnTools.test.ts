import { describe, expect, it } from 'vitest';
import { mentionsWorkspaceFileTarget, selectBuiltinTurnTools } from './agentTools';
import { documentWriteDeveloperPromptFor } from './documentTurnIntent';

const withWorkspace = {
  workspaceToolsEnabled: true,
  workspaceRoot: 'D:\\work\\app',
  workspaceToolsConsentAcknowledged: true,
  memoryEnabled: false,
};

const names = (prompt: string, settings = withWorkspace) =>
  selectBuiltinTurnTools(prompt, settings).tools.map((tool) => tool.name);

describe('selectBuiltinTurnTools', () => {
  it('offers document tools, not workspace writes, for a document request', () => {
    const tools = names('Create an HTML document titled Solar System Field Guide');
    expect(tools).toContain('write_html_document');
    expect(tools).not.toContain('workspace_write');
    expect(tools).not.toContain('workspace_edit');
    // Reading project files as source material still works.
    expect(tools).toContain('workspace_read');
    expect(tools).toContain('workspace_grep');
  });

  it('keeps workspace writes when the request names a file or folder', () => {
    expect(names('create an html page and save it as index.html')).toContain('workspace_write');
    expect(names('write a markdown guide into the docs folder')).toContain('workspace_write');
  });

  it('keeps workspace writes on turns that are not about documents', () => {
    expect(names('rename the helper in utils')).toContain('workspace_write');
  });

  it('reports the intent it routed on', () => {
    expect(selectBuiltinTurnTools('make it dark mode', withWorkspace).intent).toBe('edit');
  });
});

describe('mentionsWorkspaceFileTarget', () => {
  it('recognises files, folders and filenames', () => {
    expect(mentionsWorkspaceFileTarget('save it as notes.md')).toBe(true);
    expect(mentionsWorkspaceFileTarget('put it in the project')).toBe(true);
    expect(mentionsWorkspaceFileTarget('a guide to the solar system')).toBe(false);
  });
});

describe('documentWriteDeveloperPromptFor', () => {
  it('is present only when document write or edit tools are offered', () => {
    expect(documentWriteDeveloperPromptFor(['write_html_document', 'uuid'])).toContain('reasoning');
    expect(documentWriteDeveloperPromptFor(['edit_markdown_document'])).toContain('title before the content');
    expect(documentWriteDeveloperPromptFor(['uuid', 'workspace_write'])).toBeUndefined();
    expect(documentWriteDeveloperPromptFor([])).toBeUndefined();
  });

  it('guides how to write without telling the model to write', () => {
    expect(documentWriteDeveloperPromptFor(['write_html_document'])).toMatch(/^If you create or revise a document/);
  });
});

describe('documentWriteDeveloperPromptFor with patch_document', () => {
  it('points targeted changes at patch_document, without asking for parts up front', () => {
    const withPatch = documentWriteDeveloperPromptFor(['write_html_document', 'patch_document']) ?? '';
    expect(withPatch).toContain('use patch_document rather than rewriting it');
    expect(withPatch).not.toContain('in parts');
    expect(documentWriteDeveloperPromptFor(['write_html_document']) ?? '').not.toContain('patch_document');
  });
});

describe('documentWriteDeveloperPromptFor for a model that holds documents', () => {
  it('asks for a long document in parts only when the model sends documents in one burst', () => {
    const tools = ['write_html_document', 'patch_document'];
    expect(documentWriteDeveloperPromptFor(tools, { heldDocuments: true })).toContain('write it in parts');
    expect(documentWriteDeveloperPromptFor(tools, { heldDocuments: false })).not.toContain('in parts');
    expect(documentWriteDeveloperPromptFor(['write_html_document'], { heldDocuments: true })).not.toContain(
      'in parts',
    );
  });
});

describe('selectBuiltinTurnTools intent override', () => {
  it('offers revision tools for an app-authored prompt in any language', () => {
    const settings = { memoryEnabled: false };
    const prompt = 'Baue das Dokument weiter auf: Schreibe die Abschnitte, die noch Platzhalter sind.';
    expect(selectBuiltinTurnTools(prompt, settings).tools.map((t) => t.name)).not.toContain('patch_document');
    const { intent, tools } = selectBuiltinTurnTools(prompt, settings, null, 'edit');
    expect(intent).toBe('edit');
    expect(tools.map((t) => t.name)).toContain('patch_document');
  });
});
