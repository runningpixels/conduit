import { describe, expect, it } from 'vitest';
import { selectBuiltinWorkspaceTools, WORKSPACE_TOOL_NAMES } from './agentTools';

describe('selectBuiltinWorkspaceTools', () => {
  it('returns empty when disabled', () => {
    expect(
      selectBuiltinWorkspaceTools({
        workspaceToolsEnabled: false,
        workspaceRoot: '/tmp/ws',
        workspaceToolsConsentAcknowledged: true,
      }),
    ).toEqual([]);
  });

  it('returns empty without root or consent', () => {
    expect(
      selectBuiltinWorkspaceTools({
        workspaceToolsEnabled: true,
        workspaceRoot: null,
        workspaceToolsConsentAcknowledged: true,
      }),
    ).toEqual([]);
    expect(
      selectBuiltinWorkspaceTools({
        workspaceToolsEnabled: true,
        workspaceRoot: '/tmp/ws',
        workspaceToolsConsentAcknowledged: false,
      }),
    ).toEqual([]);
  });

  it('returns all workspace tools when enabled', () => {
    const tools = selectBuiltinWorkspaceTools({
      workspaceToolsEnabled: true,
      workspaceRoot: '/tmp/ws',
      workspaceToolsConsentAcknowledged: true,
    });
    const names = new Set(tools.map((t) => t.name));
    expect(names).toEqual(WORKSPACE_TOOL_NAMES);
    expect(names.has('workspace_read')).toBe(true);
    expect(names.has('workspace_grep')).toBe(true);
  });
});
