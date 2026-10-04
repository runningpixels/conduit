import { describe, expect, it } from 'vitest';
import { applyProviderEvent, createAssistantStreamState, type AssistantStreamState } from '../chat/streamState';
import type { ProviderEvent } from '@conduit/config-schema';
import {
  buildDraftPreview,
  headingKey,
  parsePartialWriteSection,
  sectionPreviewsFromStream,
} from './sectionPreview';

describe('parsePartialWriteSection', () => {
  const full = JSON.stringify({ heading: 'Why one repo', markdown: 'Line one.\n\n"Quoted" \\ done' });

  it('reads both fields from complete arguments', () => {
    expect(parsePartialWriteSection(full)).toEqual({
      heading: 'Why one repo',
      markdown: 'Line one.\n\n"Quoted" \\ done',
    });
  });

  it('gives the text so far at every cut, never a half escape', () => {
    for (let cut = 0; cut <= full.length; cut += 1) {
      const parsed = parsePartialWriteSection(full.slice(0, cut));
      if (parsed.markdown != null) {
        expect('Line one.\n\n"Quoted" \\ done'.startsWith(parsed.markdown)).toBe(true);
      }
      if (parsed.heading != null) expect('Why one repo'.startsWith(parsed.heading)).toBe(true);
    }
  });

  it('cuts mid-string and mid-escape', () => {
    expect(parsePartialWriteSection('{"heading": "Set')).toEqual({ heading: 'Set', markdown: null });
    expect(parsePartialWriteSection('{"heading":"Setup","markdown":"a\\')).toEqual({ heading: 'Setup', markdown: 'a' });
    expect(parsePartialWriteSection('{"heading":"Setup","markdown":"a\\n')).toEqual({ heading: 'Setup', markdown: 'a\n' });
    expect(parsePartialWriteSection('{"heading":"Setup","markdown":"a\\u00')).toEqual({ heading: 'Setup', markdown: 'a' });
    expect(parsePartialWriteSection('{"heading":"Setup","mark')).toEqual({ heading: 'Setup', markdown: null });
    expect(parsePartialWriteSection('')).toEqual({ heading: null, markdown: null });
  });

  it('decodes unicode escapes and surrogate pairs, dropping a lone half at the cut', () => {
    expect(parsePartialWriteSection('{"heading":"Caf\\u00e9","markdown":"\\ud83d\\ude00 ok"}')).toEqual({
      heading: 'Café',
      markdown: '😀 ok',
    });
    expect(parsePartialWriteSection('{"heading":"x","markdown":"hi \\ud83d')).toEqual({ heading: 'x', markdown: 'hi ' });
    // Raw (unescaped) non-ASCII text passes through.
    expect(parsePartialWriteSection('{"heading":"日本","markdown":"文章')).toEqual({ heading: '日本', markdown: '文章' });
  });

  it('skips other keys, in any order, including the old more_to_write', () => {
    expect(
      parsePartialWriteSection('{"more_to_write": true, "extra": {"a": [1, "}"]}, "markdown": "Body", "heading": "H"}'),
    ).toEqual({ heading: 'H', markdown: 'Body' });
  });
});

function stream(events: Array<Record<string, unknown>>): AssistantStreamState {
  return events.reduce<AssistantStreamState>(
    (state, event) => applyProviderEvent(state, { requestId: 'r1', ...event } as ProviderEvent),
    createAssistantStreamState('r1'),
  );
}

describe('sectionPreviewsFromStream', () => {
  it('lists unfinished write_section calls with a heading, in order', () => {
    const state = stream([
      { kind: 'toolCallStart', toolCallId: 'a', index: 0, toolId: 'write_section', name: 'write_section' },
      { kind: 'toolCallDelta', toolCallId: 'a', index: 0, content: '{"heading":"Intro","markdown":"Hel' },
      { kind: 'toolCallStart', toolCallId: 'b', index: 1, toolId: 'write_section', name: 'write_section' },
      { kind: 'toolCallDelta', toolCallId: 'b', index: 1, content: '{"heading":"Setup","markdown":"Inst' },
      { kind: 'toolCallStart', toolCallId: 'c', index: 2, toolId: 'write_section', name: 'write_section' },
      { kind: 'toolCallDelta', toolCallId: 'c', index: 2, content: '{"head' },
      { kind: 'toolCallStart', toolCallId: 'd', index: 3, toolId: 'read_draft', name: 'read_draft' },
    ]);
    expect(sectionPreviewsFromStream(state)).toEqual([
      { toolCallId: 'a', heading: 'Intro', markdown: 'Hel' },
      { toolCallId: 'b', heading: 'Setup', markdown: 'Inst' },
    ]);
  });

  it('drops a call once it has run, and everything once the turn ends', () => {
    let state = stream([
      { kind: 'toolCallStart', toolCallId: 'a', index: 0, toolId: 'write_section', name: 'write_section' },
      { kind: 'toolCallDelta', toolCallId: 'a', index: 0, content: '{"heading":"Intro","markdown":"Hello"}' },
      { kind: 'toolCallComplete', toolCallId: 'a', index: 0, arguments: { heading: 'Intro', markdown: 'Hello' } },
    ]);
    expect(sectionPreviewsFromStream(state)).toHaveLength(1);
    state = applyProviderEvent(state, {
      requestId: 'r1',
      kind: 'toolExecutionFinished',
      toolCallId: 'a',
      toolName: 'write_section',
      isError: false,
    } as ProviderEvent);
    expect(sectionPreviewsFromStream(state)).toEqual([]);
    expect(sectionPreviewsFromStream({ ...state, streaming: false })).toEqual([]);
    expect(sectionPreviewsFromStream(null)).toEqual([]);
  });
});

describe('buildDraftPreview', () => {
  const outline = [
    { heading: 'Intro', intent: '' },
    { heading: 'Setup', intent: '' },
    { heading: 'Usage', intent: '' },
  ];
  const md = '# Guide\n\n## Intro\n\nHello.\n\n### Detail\n\nMore.\n\n## Usage\n\nUse it.';

  it('replaces an existing section (heading matched without case or spacing)', () => {
    const p = buildDraftPreview(md, outline, [{ toolCallId: 'a', heading: '  intro ', markdown: 'Hi there.' }])!;
    expect(p.markdown).toBe('# Guide\n\n## Intro\n\nHi there.\n\n## Usage\n\nUse it.');
    expect(p.markdown.slice(p.ranges[0].from, p.ranges[0].to)).toBe('## Intro\n\nHi there.');
  });

  it('keeps a heading line the call wrote itself', () => {
    const p = buildDraftPreview(md, outline, [{ toolCallId: 'a', heading: 'Usage', markdown: '## Usage\n\nRun it.\n' }])!;
    expect(p.markdown.endsWith('## Usage\n\nRun it.')).toBe(true);
  });

  it('inserts a new section by outline order', () => {
    const p = buildDraftPreview(md, outline, [{ toolCallId: 'a', heading: 'Setup', markdown: 'Install it.' }])!;
    expect(p.markdown).toBe(
      '# Guide\n\n## Intro\n\nHello.\n\n### Detail\n\nMore.\n\n## Setup\n\nInstall it.\n\n## Usage\n\nUse it.',
    );
    expect(p.markdown.slice(p.ranges[0].from, p.ranges[0].to)).toBe('## Setup\n\nInstall it.');
  });

  it('appends a section the outline does not place, and starts an empty draft', () => {
    const p = buildDraftPreview(md, outline, [{ toolCallId: 'a', heading: 'Extra', markdown: 'Bonus.' }])!;
    expect(p.markdown.endsWith('## Usage\n\nUse it.\n\n## Extra\n\nBonus.\n')).toBe(true);
    expect(p.markdown.slice(p.ranges[0].from, p.ranges[0].to)).toBe('## Extra\n\nBonus.');
    const empty = buildDraftPreview('', outline, [{ toolCallId: 'a', heading: 'Intro', markdown: '' }])!;
    expect(empty.markdown).toBe('## Intro\n');
    expect(empty.ranges[0]).toMatchObject({ from: 0, to: 8 });
  });

  it('previews several calls in order and keeps earlier ranges on their text', () => {
    const p = buildDraftPreview('', outline, [
      { toolCallId: 'a', heading: 'Usage', markdown: 'Use.' },
      { toolCallId: 'b', heading: 'Intro', markdown: 'Hi.' },
      { toolCallId: 'c', heading: 'Setup', markdown: 'Inst' },
    ])!;
    expect(p.markdown).toBe('## Intro\n\nHi.\n\n## Setup\n\nInst\n\n## Usage\n\nUse.\n');
    const texts = Object.fromEntries(p.ranges.map((r) => [r.toolCallId, p.markdown.slice(r.from, r.to)]));
    expect(texts).toEqual({ a: '## Usage\n\nUse.', b: '## Intro\n\nHi.', c: '## Setup\n\nInst' });
  });

  it('ignores headings inside code fences and shows a heading still arriving as the outline heading', () => {
    const fenced = '## Intro\n\n```\n## Setup\n```\n';
    const p = buildDraftPreview(fenced, outline, [{ toolCallId: 'a', heading: 'Setup', markdown: '##' }])!;
    expect(p.markdown).toBe('## Intro\n\n```\n## Setup\n```\n\n## Setup\n');
    expect(buildDraftPreview(md, outline, [])).toBeNull();
  });

  it('matches headings like the backend', () => {
    expect(headingKey('##  Getting   Started ##')).toBe('getting started');
  });
});
