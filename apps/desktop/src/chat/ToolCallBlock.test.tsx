import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ToolCallBlock, TOOL_ARGUMENT_MAX_CHARS, toolArgumentDisplay } from './ToolCallBlock';
import type { ToolCallState } from './streamState';

vi.mock('../ipc/client', () => ({
  approveConnectorToolCall: vi.fn(),
  denyConnectorToolCall: vi.fn(),
}));

const size = (bytes: number) => `${bytes} B`;

describe('toolArgumentDisplay', () => {
  it('shows a workspace file body as its size', () => {
    expect(toolArgumentDisplay('workspace_write', 'content', '<p>hi</p>', size)).toBe('9 B');
    expect(toolArgumentDisplay('workspace_edit', 'content', 'abc', size)).toBe('3 B');
  });

  it('keeps short single-line values as they are', () => {
    expect(toolArgumentDisplay('workspace_write', 'path', 'site/index.html', size)).toBe('site/index.html');
    expect(toolArgumentDisplay('calculator', 'expression', '2 + 2', size)).toBe('2 + 2');
    expect(toolArgumentDisplay('random', 'max', 100, size)).toBe('100');
  });

  it('cuts long or multi-line values to the first line plus the size', () => {
    const long = 'x'.repeat(TOOL_ARGUMENT_MAX_CHARS + 50);
    expect(toolArgumentDisplay('some_tool', 'query', long, size)).toBe(
      `${'x'.repeat(TOOL_ARGUMENT_MAX_CHARS)}… (${long.length} B)`,
    );
    expect(toolArgumentDisplay('some_tool', 'notes', 'first\nsecond', size)).toBe('first… (12 B)');
  });
});

describe('ToolCallBlock generic card', () => {
  it('never renders the file body of a workspace_write call', () => {
    const body = `<!DOCTYPE html>\n<html>${'<p>planet</p>'.repeat(4000)}</html>`;
    const toolCall: ToolCallState = {
      toolCallId: 'tc-1',
      toolId: 'workspace_write',
      name: 'workspace_write',
      argumentsText: '',
      arguments: { path: 'solar-system.html', content: body },
      complete: true,
      status: 'completed',
      startedAt: 0,
      endedAt: 67,
    };
    const { container } = render(<ToolCallBlock toolCall={toolCall} defaultCollapsed={false} />);
    const text = container.textContent ?? '';
    expect(text).toContain('solar-system.html');
    expect(text).not.toContain('<p>planet</p>');
    expect(text.length).toBeLessThan(1000);
  });
});
