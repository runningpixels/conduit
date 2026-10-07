import { describe, expect, it } from 'vitest';
import { describeJsonError, lineAndColumn } from './jsonError';

const t = (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}`;

function parseError(text: string): unknown {
  try {
    JSON.parse(text);
  } catch (e) {
    return e;
  }
  throw new Error('parsed');
}

describe('lineAndColumn', () => {
  it('counts lines and columns from one', () => {
    expect(lineAndColumn('ab\ncd\nef', 0)).toEqual({ line: 1, column: 1 });
    expect(lineAndColumn('ab\ncd\nef', 4)).toEqual({ line: 2, column: 2 });
    expect(lineAndColumn('ab', 99)).toEqual({ line: 1, column: 3 });
  });
});

describe('describeJsonError', () => {
  it('puts a position and a hint on a trailing comma', () => {
    const text = '{\n  "steps": [],\n}';
    const out = describeJsonError(text, parseError(text), t)!;
    expect(out).toContain('"line":3');
    expect(out).toContain('jsonError.quotedName');
  });

  it('says when the text ends too early', () => {
    const text = '{\n  "a": [1, 2';
    const out = describeJsonError(text, parseError(text), t)!;
    expect(out).toContain('"line":2');
    expect(out).toContain('jsonError.endEarly');
  });

  it('recognises a missing comma', () => {
    const text = '{"a": 1 "b": 2}';
    const out = describeJsonError(text, parseError(text), t)!;
    expect(out).toContain('jsonError.separator');
  });

  it('uses a generic hint for the rest, and gives up with no position', () => {
    const text = "{'a': 1}";
    expect(describeJsonError(text, parseError(text), t)).toContain('"line":1');
    expect(describeJsonError('x', new Error('weird'), t)).toBeNull();
  });

  it('reads engine-written positions and line/column pairs', () => {
    expect(
      describeJsonError('abc\ndef', new Error('Expected double-quoted property name in JSON at position 5'), t),
    ).toContain('"line":2,"column":2');
    expect(describeJsonError('', new Error('Unexpected token } in JSON (line 4 column 12)'), t)).toContain(
      '"line":4,"column":12',
    );
  });
});
