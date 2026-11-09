import { describe, expect, it } from 'vitest';
import { clock, insertDictation } from './dictation';

describe('insertDictation', () => {
  it('fills an empty composer and puts the caret after the text', () => {
    expect(insertDictation('', 0, 0, ' Hello there. ')).toEqual({ value: 'Hello there.', caret: 12 });
  });

  it('adds spaces where words would run together, and none where there already is one', () => {
    expect(insertDictation('Write a poem', 12, 12, 'about rain')).toEqual({
      value: 'Write a poem about rain',
      caret: 23,
    });
    expect(insertDictation('Write a poem', 8, 8, 'short')).toEqual({ value: 'Write a short poem', caret: 13 });
  });

  it('replaces the selection', () => {
    expect(insertDictation('Say hi to Bob', 4, 6, 'hello')).toEqual({ value: 'Say hello to Bob', caret: 9 });
  });

  it('adds no spaces around Chinese or Japanese', () => {
    expect(insertDictation('你好', 2, 2, '世界')).toEqual({ value: '你好世界', caret: 4 });
    expect(insertDictation('東京は', 3, 3, '晴れです')).toEqual({ value: '東京は晴れです', caret: 7 });
    // Korean is written with spaces.
    expect(insertDictation('안녕하세요', 5, 5, '반갑습니다')).toEqual({ value: '안녕하세요 반갑습니다', caret: 11 });
  });

  it('leaves the text alone when nothing was said', () => {
    expect(insertDictation('Draft', 5, 5, '   ')).toEqual({ value: 'Draft', caret: 5 });
  });

  it('clamps a stale caret to the text', () => {
    expect(insertDictation('Hi', 10, 12, 'there')).toEqual({ value: 'Hi there', caret: 8 });
  });
});

describe('clock', () => {
  it('shows m:ss', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(9.7)).toBe('0:09');
    expect(clock(75)).toBe('1:15');
    expect(clock(300)).toBe('5:00');
  });
});
