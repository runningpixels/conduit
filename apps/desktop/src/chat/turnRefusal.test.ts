import { describe, expect, it } from 'vitest';
import { isWorkflowBusyRefusal } from './turnRefusal';

describe('isWorkflowBusyRefusal', () => {
  it('recognises the refusal a running workflow causes', () => {
    expect(
      isWorkflowBusyRefusal('The workflow “Weekly numbers” is updating this right now. Try again when it has finished.'),
    ).toBe(true);
  });

  it('does not match other refusals or failures', () => {
    expect(isWorkflowBusyRefusal('This conversation is already working on a reply. Wait for it to finish, or stop it first.')).toBe(false);
    expect(isWorkflowBusyRefusal('Bad API key')).toBe(false);
    expect(isWorkflowBusyRefusal('')).toBe(false);
  });
});
