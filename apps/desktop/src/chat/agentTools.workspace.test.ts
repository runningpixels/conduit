import { describe, expect, it } from 'vitest';
import {
  conversationWorkspaceDisabled,
  resolveActiveWorkspaceRoot,
  selectBuiltinWorkspaceTools,
  WORKSPACE_TOOL_NAMES,
  workspaceFolderLabel,
} from './agentTools';

describe('resolveActiveWorkspaceRoot', () => {
  it('prefers conversation root over settings', () => {
    expect(
      resolveActiveWorkspaceRoot('/chat/project', {
        workspaceToolsEnabled: true,
        workspaceRoot: '/settings/default',
        workspaceToolsConsentAcknowledged: true,
      }),
    ).toBe('/chat/project');
  });

  it('falls back to settings when conversation unbound', () => {
    expect(
      resolveActiveWorkspaceRoot(null, {
        workspaceToolsEnabled: true,
        workspaceRoot: '/settings/default',
        workspaceToolsConsentAcknowledged: true,
      }),
    ).toBe('/settings/default');
  });

  it('gives a chat with folder access turned off no folder, not even the default', () => {
    const settings = {
      workspaceToolsEnabled: true,
      workspaceRoot: '/settings/default',
      workspaceToolsConsentAcknowledged: true,
    };
    expect(resolveActiveWorkspaceRoot(null, { ...settings, chatWorkspaceDisabled: true })).toBeNull();
    expect(selectBuiltinWorkspaceTools({ ...settings, chatWorkspaceDisabled: true }, null)).toEqual([]);
    // Other chats keep the default.
    expect(selectBuiltinWorkspaceTools(settings, null).length).toBeGreaterThan(0);
    expect(conversationWorkspaceDisabled({ workspaceDisabled: true })).toBe(true);
    expect(conversationWorkspaceDisabled({})).toBe(false);
    expect(conversationWorkspaceDisabled(undefined)).toBe(false);
  });

  it('ignores settings when disabled or no consent', () => {
    expect(
      resolveActiveWorkspaceRoot(null, {
        workspaceToolsEnabled: false,
        workspaceRoot: '/settings/default',
        workspaceToolsConsentAcknowledged: true,
      }),
    ).toBeNull();
  });
});

describe('selectBuiltinWorkspaceTools', () => {
  it('returns tools for a conversation bind without settings enable', () => {
    const tools = selectBuiltinWorkspaceTools(
      {
        workspaceToolsEnabled: false,
        workspaceRoot: null,
        workspaceToolsConsentAcknowledged: false,
      },
      'D:\\work\\app',
    );
    expect(new Set(tools.map((t) => t.name))).toEqual(WORKSPACE_TOOL_NAMES);
  });

  it('returns empty when nothing is bound', () => {
    expect(
      selectBuiltinWorkspaceTools({
        workspaceToolsEnabled: false,
        workspaceRoot: null,
        workspaceToolsConsentAcknowledged: true,
      }),
    ).toEqual([]);
  });
});

describe('workspaceFolderLabel', () => {
  it('returns the last path segment', () => {
    expect(workspaceFolderLabel('D:\\aidev\\my-project')).toBe('my-project');
    expect(workspaceFolderLabel('/Users/me/code/app/')).toBe('app');
  });
});
