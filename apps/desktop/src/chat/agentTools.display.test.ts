import { describe, expect, it } from 'vitest';
import type { ToolCallState } from './streamState';
import {
  summarizeDocumentToolCall,
  redactDocumentToolArguments,
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