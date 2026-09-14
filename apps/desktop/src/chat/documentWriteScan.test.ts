import { describe, expect, it } from 'vitest';
import {
  activeDocumentWrite,
  advanceDocumentWriteScan,
  documentWriteStalled,
  DOCUMENT_WRITE_STALL_MS,
  startDocumentWriteScan,
  type DocumentWriteScan,
} from './documentWriteScan';
import { applyProviderEvent, createAssistantStreamState } from './streamState';

function scanAll(toolName: string, chunks: string[]): DocumentWriteScan {
  let scan = startDocumentWriteScan(toolName);
  if (!scan) throw new Error(`${toolName} is not a content tool`);
  for (const chunk of chunks) scan = advanceDocumentWriteScan(scan, chunk);
  return scan;
}

/** Split a string into fragments of every size from 1 to `max`, cycling. */
function fragments(text: string, max = 7): string[] {
  const out: string[] = [];
  let size = 1;
  for (let i = 0; i < text.length; ) {
    out.push(text.slice(i, i + size));
    i += size;
    size = (size % max) + 1;
  }
  return out;
}

describe('documentWriteScan', () => {
  it('ignores tools that carry no document content', () => {
    expect(startDocumentWriteScan('uuid')).toBeUndefined();
    expect(startDocumentWriteScan('export_document')).toBeUndefined();
  });

  it('reads the title and counts content regardless of how the JSON is split', () => {
    const html = '<!doctype html>\n<html>\n<body>"quoted" \\ back</body>\n</html>';
    const args = JSON.stringify({ title: 'Q3 “report”', html, filename: 'q3.html' });
    for (const max of [1, 3, 64, args.length]) {
      const scan = scanAll('write_html_document', fragments(args, max));
      expect(scan.title).toBe('Q3 “report”');
      expect(scan.filename).toBe('q3.html');
      expect(scan.contentChars).toBe(html.length);
      expect(scan.contentLines).toBe(4);
    }
  });

  it('decodes \\u escapes split across fragments', () => {
    const scan = scanAll('write_markdown_document', ['{"title":"Caf\\u', '00e9', '","markdown":"a\\u00', 'e9"}']);
    expect(scan.title).toBe('Café');
    expect(scan.contentChars).toBe(2);
  });

  it('does not mistake keys inside the document for top-level arguments', () => {
    const html = '<script>const x = {"title": "inner", "html": "no"};</script>';
    const scan = scanAll('write_html_document', [JSON.stringify({ html, title: 'Outer' })]);
    expect(scan.title).toBe('Outer');
    expect(scan.contentChars).toBe(html.length);
  });

  it('reports partial progress mid-document', () => {
    const scan = scanAll('edit_html_document', ['{"artifact_id":"a1","updated_html":"line one\\nline t']);
    expect(scan.title).toBeUndefined();
    expect(scan.contentLines).toBe(2);
    expect(scan.contentChars).toBe('line one\nline t'.length);
  });

  it('stays at zero before the content string opens', () => {
    const scan = scanAll('write_html_document', ['{"title":"Draft"']);
    expect(scan.contentChars).toBe(0);
    expect(scan.contentLines).toBe(0);
  });
});

describe('activeDocumentWrite', () => {
  const start = (name: string) =>
    applyProviderEvent(createAssistantStreamState('req'), {
      kind: 'toolCallStart',
      requestId: 'req',
      toolCallId: 'tc1',
      index: 0,
      toolId: name,
      name,
    });

  it('tracks a streaming document tool call until its arguments complete', () => {
    let state = start('write_html_document');
    state = applyProviderEvent(state, {
      kind: 'toolCallDelta',
      requestId: 'req',
      toolCallId: 'tc1',
      index: 1,
      content: '{"title":"Plan","html":"<p>\\n',
    });
    const write = activeDocumentWrite(state);
    expect(write).toMatchObject({ mode: 'create', kind: 'html', title: 'Plan', contentLines: 2 });
    expect(write?.lastActivityAt).toBeGreaterThan(0);

    state = applyProviderEvent(state, {
      kind: 'toolCallComplete',
      requestId: 'req',
      toolCallId: 'tc1',
      index: 2,
      arguments: { title: 'Plan', html: '<p>\n' },
    });
    expect(activeDocumentWrite(state)).toBeUndefined();
  });

  it('is undefined for non-document tools and for turns that stopped', () => {
    expect(activeDocumentWrite(start('uuid'))).toBeUndefined();
    const stopped = { ...start('write_text_document'), streaming: false };
    expect(activeDocumentWrite(stopped)).toBeUndefined();
    expect(activeDocumentWrite(start('edit_text_document'))?.mode).toBe('edit');
  });
});

describe('documentWriteStalled', () => {
  it('fires only after the stall window without activity', () => {
    expect(documentWriteStalled(undefined, 10 ** 9)).toBe(false);
    expect(documentWriteStalled(1000, 1000 + DOCUMENT_WRITE_STALL_MS - 1)).toBe(false);
    expect(documentWriteStalled(1000, 1000 + DOCUMENT_WRITE_STALL_MS)).toBe(true);
  });
});
