import { describe, expect, it } from 'vitest';
import { dataStepSummary } from './stepSummary';

const t = (id: string, values?: Record<string, unknown>) => `${id.split('.').pop()} ${JSON.stringify(values)}`;
const size = (bytes: number) => `${bytes} B`;

describe('dataStepSummary', () => {
  it('gives a file read its name and size', () => {
    const output = { path: 'a/m.csv', name: 'm.csv', text: 'x', modified: '2026-10-01T00:00:00+02:00', bytes: 1200 };
    expect(dataStepSummary({ output }, t, size)).toBe('file {"name":"m.csv","size":"1200 B"}');
  });

  it('gives a table its row count and first columns', () => {
    const output = { columns: ['a', 'b', 'c', 'd', 'e'], rows: [], count: 12, text: '' };
    expect(dataStepSummary({ output }, t, size)).toBe('table {"count":12,"columns":"a, b, c, d…"}');
  });

  it('says nothing for other steps', () => {
    expect(dataStepSummary({ output: { text: 'hi' } }, t, size)).toBeNull();
    expect(dataStepSummary({ output: null }, t, size)).toBeNull();
    // JSON that is not a list of records has no columns.
    expect(dataStepSummary({ output: { data: {}, text: '{}' } }, t, size)).toBeNull();
  });
});
