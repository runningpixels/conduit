import { describe, expect, it } from 'vitest';
import { findHashTrigger } from './hashTrigger';

describe('findHashTrigger (D11)', () => {
  it('opens on # at the start of the text', () => {
    expect(findHashTrigger('#', 1)).toEqual({ start: 0, query: '' });
    expect(findHashTrigger('#not', 4)).toEqual({ start: 0, query: 'not' });
  });

  it('opens on # right after whitespace', () => {
    expect(findHashTrigger('pick #tag', 9)).toEqual({ start: 5, query: 'tag' });
    expect(findHashTrigger('a\n#tag', 6)).toEqual({ start: 2, query: 'tag' });
    expect(findHashTrigger('a\t#tag', 6)).toEqual({ start: 2, query: 'tag' });
  });

  it('the query runs from # to the caret, not the whole word', () => {
    // caret sits between "t" and "ag" of "#tag"
    expect(findHashTrigger('pick #tag here', 7)).toEqual({ start: 5, query: 't' });
  });

  it('is not active mid-word', () => {
    expect(findHashTrigger('a#b', 3)).toBeNull();
    expect(findHashTrigger('a#b', 2)).toBeNull();
  });

  it('is not active inside a URL', () => {
    expect(findHashTrigger('see http://x/#y', 15)).toBeNull();
  });

  it('is not active on ## (a Markdown H2)', () => {
    expect(findHashTrigger('##', 2)).toBeNull();
    expect(findHashTrigger('##heading', 9)).toBeNull();
  });

  it('a heading (# followed by a space) closes the trigger at the space', () => {
    // "# " — caret right after the space: nothing left to scan back over.
    expect(findHashTrigger('# ', 2)).toBeNull();
    // Still open right up until the space is typed.
    expect(findHashTrigger('#', 1)).toEqual({ start: 0, query: '' });
  });

  it('has no whitespace in the query', () => {
    expect(findHashTrigger('#foo bar', 8)).toBeNull(); // caret after "bar", but "foo bar" run is broken by the space
  });

  it('is not active with no run at all before the caret', () => {
    expect(findHashTrigger('hi ', 3)).toBeNull();
    expect(findHashTrigger('', 0)).toBeNull();
  });

  it('is not active inside a fenced code block', () => {
    const text = '```\n#tag\n```';
    const caret = text.indexOf('#tag') + 4; // right after "#tag", inside the fence
    expect(findHashTrigger(text, caret)).toBeNull();
  });

  it('is active again once the fence has closed', () => {
    const text = '```\ncode\n```\n#tag';
    expect(findHashTrigger(text, text.length)).toEqual({
      start: text.length - 4,
      query: 'tag',
    });
  });

  it('is not active inside an inline code span on the same line', () => {
    // A space after the opening backtick, so the run ending at the caret
    // still starts with `#` (glued to the backtick it would fail on that
    // rule instead) — this isolates the inline-code check itself.
    const text = 'see ` #tag` here';
    const caret = text.indexOf('#tag') + 4; // inside the backticks
    expect(findHashTrigger(text, caret)).toBeNull();
  });

  it('an inline code span on an earlier line does not affect the current line', () => {
    const text = 'code `x` on line one\n#tag';
    expect(findHashTrigger(text, text.length)).toEqual({
      start: text.length - 4,
      query: 'tag',
    });
  });

  it('rejects out-of-range carets defensively', () => {
    expect(findHashTrigger('abc', -1)).toBeNull();
    expect(findHashTrigger('abc', 10)).toBeNull();
  });

  it('CJK text before # requires a real whitespace boundary, same as Latin text', () => {
    // Glued directly to CJK text: mid-word, same as `a#b`.
    expect(findHashTrigger('你好#文件', 5)).toBeNull();
    // A real space (including the CJK ideographic space) still opens it.
    expect(findHashTrigger('你好 #文件', 6)).toEqual({ start: 3, query: '文件' });
    expect(findHashTrigger('你好　#文件', 6)).toEqual({ start: 3, query: '文件' });
  });
});
