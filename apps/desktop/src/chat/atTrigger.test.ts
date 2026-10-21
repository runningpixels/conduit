import { describe, expect, it } from 'vitest';
import { findAtTrigger } from './atTrigger';

describe('findAtTrigger', () => {
  it('opens on @ at the start and after whitespace', () => {
    expect(findAtTrigger('@', 1)).toEqual({ start: 0, query: '' });
    expect(findAtTrigger('@res', 4)).toEqual({ start: 0, query: 'res' });
    expect(findAtTrigger('ask @res', 8)).toEqual({ start: 4, query: 'res' });
    expect(findAtTrigger('line\n@x', 7)).toEqual({ start: 5, query: 'x' });
  });

  it('is inert in an email address or mid-word', () => {
    expect(findAtTrigger('me@example.com', 14)).toBeNull();
    expect(findAtTrigger('a@', 2)).toBeNull();
  });

  it('is inert on @@ and once whitespace follows the query', () => {
    expect(findAtTrigger('@@x', 3)).toBeNull();
    expect(findAtTrigger('@res ', 5)).toBeNull();
  });

  it('is inert inside code', () => {
    expect(findAtTrigger('`@x', 3)).toBeNull();
    expect(findAtTrigger('```\n@x', 6)).toBeNull();
    expect(findAtTrigger('`a` @x', 6)).toEqual({ start: 4, query: 'x' });
  });

  it('only looks at the text before the caret', () => {
    expect(findAtTrigger('@research later', 4)).toEqual({ start: 0, query: 'res' });
    expect(findAtTrigger('hello', 99)).toBeNull();
  });
});
