import { describe, expect, it } from 'vitest';
import { groupToolCalls } from './AssistantMessage';
import type { ToolCallState } from './streamState';

function tc(id: string, name: string): ToolCallState {
  return { toolCallId: id, toolId: id, name, argumentsText: '', complete: true };
}

describe('groupToolCalls (P3.3)', () => {
  it('groups consecutive same-name calls into one group card', () => {
    const grouped = groupToolCalls([tc('a', 'read_file'), tc('b', 'read_file'), tc('c', 'read_file')]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ group: true, name: 'read_file' });
    if ('group' in grouped[0]) expect(grouped[0].calls).toHaveLength(3);
  });

  it('keeps non-consecutive same-name calls as separate cards', () => {
    const grouped = groupToolCalls([tc('a', 'read'), tc('b', 'write'), tc('c', 'read')]);
    expect(grouped).toHaveLength(3);
    expect('group' in grouped[0]).toBe(false);
    expect('group' in grouped[2]).toBe(false);
  });

  it('keeps a singleton call ungrouped', () => {
    const grouped = groupToolCalls([tc('a', 'read_file')]);
    expect(grouped).toHaveLength(1);
    expect('group' in grouped[0]).toBe(false);
  });

  it('handles empty input', () => {
    expect(groupToolCalls([])).toEqual([]);
  });

  it('mixes groups and singles in order', () => {
    const grouped = groupToolCalls([
      tc('a', 'search'), tc('b', 'search'),
      tc('c', 'read'),
      tc('d', 'write'), tc('e', 'write'), tc('f', 'write'),
    ]);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ group: true, name: 'search' });
    expect('group' in grouped[1]).toBe(false);
    expect(grouped[2]).toMatchObject({ group: true, name: 'write' });
  });
});
