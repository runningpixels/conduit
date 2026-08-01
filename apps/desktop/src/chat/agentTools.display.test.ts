import { describe, expect, it } from 'vitest';
import type { Artifact } from '../ipc/contracts';
import type { AssistantStreamState, ToolCallState } from './streamState';
import {
  summarizeDocumentToolCall,
  redactDocumentToolArguments,
  documentToolArtifactKind,
  isDocumentCreateTool,
  isDocumentContentTool,
  resolveDocumentArtifactId,
} from './agentTools';

function makeToolCall(name: string, args: Record<string, unknown>): ToolCallState {
  return {
    toolCallId: 'tc-1',
    toolId: name,
    name,
    argumentsText: JSON.stringify(args),
    arguments: args,
    complete: true,
    status: 'completed',
  };
}

function makeStreamState(toolCalls: ToolCallState[]): AssistantStreamState {
  return {
    requestId: 'req-1',
    blocks: [],
    reasoning: [],
    toolCalls,
    searchSources: [],
    interrupted: false,
    streaming: false,
  };
}

describe('agentTools display helpers', () => {
  it('summarizes write_html_document without exposing content', () => {
    const tc = makeToolCall('write_html_document', {
      title: 'History of FIFA',
      filename: 'history-of-fifa.html',
      html: '<!doctype html>\n<html><body>ok</body></html>',
    });
    const s = summarizeDocumentToolCall(tc)!;
    expect(s.action).toBe('Create');
    expect(s.kind).toBe('HTML');
    expect(s.title).toBe('History of FIFA');
    expect(s.filename).toBe('history-of-fifa.html');
    expect(s.lineCount).toBe(2);
    expect(s.charCount).toBeGreaterThan(10);
  });

  it('redacts the html content field', () => {
    const args = { title: 'x', html: '<!doctype html>...</html>' };
    const redacted = redactDocumentToolArguments(args, 'write_html_document');
    expect(redacted.html).toBe('…');
    expect(redacted.title).toBe('x');
  });

  it('handles edit_markdown_document summary and redaction', () => {
    const tc = makeToolCall('edit_markdown_document', {
      artifact_id: 'a1',
      updated_markdown: '# Title\n\nBody line 1\nBody line 2',
    });
    const s = summarizeDocumentToolCall(tc)!;
    expect(s.action).toBe('Edit');
    expect(s.kind).toBe('Markdown');
    expect(s.lineCount).toBe(4);
    const redacted = redactDocumentToolArguments(tc.arguments!, tc.name);
    expect(redacted.updated_markdown).toBe('…');
  });
});

describe('document tool activity helpers', () => {
  it('classifies create vs content tools and kinds', () => {
    expect(isDocumentContentTool('write_html_document')).toBe(true);
    expect(isDocumentContentTool('export_document')).toBe(false);
    expect(isDocumentCreateTool('write_html_document')).toBe(true);
    expect(isDocumentCreateTool('edit_html_document')).toBe(false);
    expect(documentToolArtifactKind('write_html_document')).toBe('html');
    expect(documentToolArtifactKind('edit_markdown_document')).toBe('markdown');
    expect(documentToolArtifactKind('write_text_document')).toBe('text');
  });

  it('resolveDocumentArtifactId uses edit artifact_id when present', () => {
    const state = makeStreamState([
      makeToolCall('edit_html_document', {
        artifact_id: 'existing-1',
        updated_html: '<html></html>',
      }),
    ]);
    expect(resolveDocumentArtifactId(state, [])).toBe('existing-1');
  });

  it('resolveDocumentArtifactId falls back to newest listed for new writes', () => {
    const state = makeStreamState([
      makeToolCall('write_html_document', { html: '<html></html>' }),
    ]);
    const listed: Artifact[] = [
      {
        id: 'newest',
        conversationId: 'c1',
        kind: 'html',
        createdAt: '2026-01-02T00:00:00Z',
      },
      {
        id: 'older',
        conversationId: 'c1',
        kind: 'html',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
    expect(resolveDocumentArtifactId(state, listed)).toBe('newest');
  });
});
