import { afterEach, describe, expect, it } from 'vitest';
import { classifyDocumentWrite, readDocumentWriteStreaming, recordDocumentWrite } from './streamingBehavior';
import { startDocumentWriteScan } from './documentWriteScan';
import type { ToolCallState } from './streamState';

function write(overrides: { chars?: number; durationMs: number; html?: string; name?: string }): ToolCallState {
  const name = overrides.name ?? 'write_html_document';
  const scan = startDocumentWriteScan(name);
  return {
    toolCallId: 'tc',
    toolId: name,
    name,
    argumentsText: '',
    arguments: overrides.html !== undefined ? { html: overrides.html } : {},
    complete: true,
    startedAt: 1000,
    endedAt: 1000 + overrides.durationMs,
    documentWrite: scan ? { ...scan, contentChars: overrides.chars ?? 0 } : undefined,
  };
}

describe('classifyDocumentWrite', () => {
  it('reads a large document that arrived at once as held back', () => {
    expect(classifyDocumentWrite(write({ chars: 13_900, durationMs: 700 }))).toBe('holds');
  });

  it('reads a large document that arrived over time as streamed', () => {
    expect(classifyDocumentWrite(write({ chars: 13_900, durationMs: 4_000 }))).toBe('streams');
  });

  it('uses the parsed arguments when no fragments were counted', () => {
    expect(classifyDocumentWrite(write({ chars: 0, durationMs: 0, html: 'x'.repeat(5_000) }))).toBe('holds');
  });

  it('draws no conclusion from small documents, open calls or other tools', () => {
    expect(classifyDocumentWrite(write({ chars: 500, durationMs: 100 }))).toBeUndefined();
    expect(classifyDocumentWrite({ ...write({ chars: 9_000, durationMs: 100 }), complete: false })).toBeUndefined();
    expect(classifyDocumentWrite(write({ chars: 9_000, durationMs: 100, name: 'uuid' }))).toBeUndefined();
  });
});

describe('recordDocumentWrite', () => {
  afterEach(() => localStorage.removeItem('conduit:v10-document-write-streaming'));

  it('remembers the latest behaviour per provider and model', () => {
    expect(readDocumentWriteStreaming('openrouter', 'glm')).toBeUndefined();
    recordDocumentWrite('openrouter', 'glm', write({ chars: 9_000, durationMs: 300 }));
    expect(readDocumentWriteStreaming('openrouter', 'glm')).toBe('holds');
    expect(readDocumentWriteStreaming('anthropic', 'glm')).toBeUndefined();
    recordDocumentWrite('openrouter', 'glm', write({ chars: 9_000, durationMs: 6_000 }));
    expect(readDocumentWriteStreaming('openrouter', 'glm')).toBe('streams');
  });
});
