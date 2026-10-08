import { describe, expect, it } from 'vitest';
import type { WorkflowReview } from '../ipc/contracts';
import { permissionText, reviewText } from './permissionText';

const t = (id: string, values?: Record<string, unknown>) =>
  values ? `${id.split('.').pop()} ${JSON.stringify(values)}` : (id.split('.').pop() ?? id);

describe('permissionText', () => {
  it('names each kind, with the display name when there is one', () => {
    expect(permissionText({ kind: 'host', host: 'bbc.com', label: null, local: null }, t)).toBe('host {"host":"bbc.com"}');
    expect(permissionText({ kind: 'anyHost', stepId: 'page', label: null, local: null }, t)).toBe('anyHost {"step":"page"}');
    expect(permissionText({ kind: 'webSearch', backend: 'brave', label: 'Brave', local: null }, t)).toBe(
      'webSearch {"backend":"Brave"}',
    );
    expect(permissionText({ kind: 'model', provider: 'ollama', label: 'Ollama', local: true }, t)).toBe(
      'modelLocal {"provider":"Ollama"}',
    );
    expect(permissionText({ kind: 'model', provider: 'openai', label: null, local: false }, t)).toBe(
      'modelCloud {"provider":"openai"}',
    );
    expect(permissionText({ kind: 'saveDocuments', label: null, local: null }, t)).toBe('saveDocuments');
  });
});

describe('agent tools', () => {
  it('lists what the tools let the step do', () => {
    expect(
      permissionText({ kind: 'agentTools', stepId: 'think', tools: ['web_fetch', 'web_search'], label: null, local: null }, t),
    ).toBe('agentTools {"step":"think","tools":"webFetch, webSearch"}');
  });
});

describe('reviewText', () => {
  it('names the address a step got when any address may be asked about', () => {
    const review: WorkflowReview = {
      runId: 'r1',
      workflowId: 'w1',
      workflowName: 'Morning',
      stepId: 'page',
      permission: { kind: 'anyHost', stepId: 'page', label: null, local: null },
      url: 'https://elsewhere.org/x',
      requestedAt: '2026-09-29T08:00:00Z',
      expiresAt: '2026-09-30T08:00:00Z',
    };
    expect(reviewText(review, t)).toBe('anyHost {"url":"https://elsewhere.org/x","step":"page"}');
  });
});

describe('read folder', () => {
  it('names the folder, in the list and in a review', () => {
    const p = { kind: 'readFolder', path: 'C:\\Reports', label: null, local: null } as const;
    expect(permissionText(p, t)).toBe('readFolder {"folder":"C:\\\\Reports"}');
    const review: WorkflowReview = {
      runId: 'r1',
      workflowId: 'w1',
      workflowName: 'Weekly',
      stepId: 'file',
      permission: p,
      url: null,
      requestedAt: '2026-09-29T08:00:00Z',
      expiresAt: '2026-09-30T08:00:00Z',
    };
    expect(reviewText(review, t)).toBe('readFolder {"folder":"C:\\\\Reports"}');
  });
});

describe('editDocument', () => {
  it('names the deck or the draft it will change', () => {
    const deck = { kind: 'editDocument', documentKind: 'deck', id: 'd1', title: 'Q3 numbers', label: null, local: null } as const;
    const draft = { kind: 'editDocument', documentKind: 'draft', id: 'p1', title: 'Monthly report', label: null, local: null } as const;
    expect(permissionText(deck, t)).toBe('editDeck {"title":"Q3 numbers"}');
    expect(permissionText(draft, t)).toBe('editDraft {"title":"Monthly report"}');
    const review = (permission: typeof deck | typeof draft): WorkflowReview => ({
      runId: 'r1',
      workflowId: 'w1',
      workflowName: 'Weekly numbers',
      stepId: 'deck',
      permission,
      url: null,
      requestedAt: '2026-10-07T08:00:00Z',
      expiresAt: '2026-10-07T09:00:00Z',
    });
    expect(reviewText(review(deck), t)).toBe('editDeck {"title":"Q3 numbers"}');
    expect(reviewText(review(draft), t)).toBe('editDraft {"title":"Monthly report"}');
  });
});
