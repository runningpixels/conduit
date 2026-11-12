import { describe, expect, it } from 'vitest';
import { chatBrowserAllowed } from './agentTools';

describe('chatBrowserAllowed', () => {
  const on = { workflowComputer: { enabled: true }, localOnly: false };

  it('needs the chat tick, Computer on and not local-only', () => {
    expect(chatBrowserAllowed({ use: true }, on)).toBe(true);
    expect(chatBrowserAllowed({ use: false }, on)).toBe(false);
    expect(chatBrowserAllowed(null, on)).toBe(false);
    expect(chatBrowserAllowed({ use: true }, { ...on, workflowComputer: { enabled: false } })).toBe(false);
    expect(chatBrowserAllowed({ use: true }, { localOnly: false })).toBe(false);
    expect(chatBrowserAllowed({ use: true }, { ...on, localOnly: true })).toBe(false);
  });
});
