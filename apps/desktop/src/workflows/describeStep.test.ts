import { describe, expect, it } from 'vitest';
import { describeStep } from './describeStep';
import type { WorkflowStep } from '../ipc/contracts';

const KEYS: Record<string, string> = {
  'workspace.workflows.editor.field.text': 'text',
  'workspace.workflows.editor.trigger.path': 'File path',
};
const t = (id: string, values?: Record<string, unknown>) =>
  id.endsWith('readFile') || id.endsWith('exportFile') ? `${id.split('.').pop()} ${JSON.stringify(values)}` : (KEYS[id] ?? id);

describe('describeStep references', () => {
  it('shows each reference as the label its editor chip carries', () => {
    expect(describeStep({ id: 'r', type: 'read_file', path: '{{trigger.path}}' }, t)).toBe(
      'readFile {"path":"[File path]"}',
    );
    expect(describeStep({ id: 'e', type: 'export_file', name: '{{ steps.fetch.text }}!', content: '' }, t)).toBe(
      'exportFile {"name":"[fetch · text]!"}',
    );
    expect(describeStep({ id: 'r', type: 'read_file', path: '{{inputs.t}}' }, t, { t: 'Topic' })).toBe(
      'readFile {"path":"[Topic]"}',
    );
  });

  it('leaves literal text, an escaped reference and unknown input references alone', () => {
    expect(describeStep({ id: 'r', type: 'read_file', path: 'a \\{{trigger.path}} b' }, t)).toBe(
      'readFile {"path":"a \\\\{{trigger.path}} b"}',
    );
    expect(describeStep({ id: 'r', type: 'read_file', path: '{{inputs.gone}}' }, t)).toBe(
      'readFile {"path":"{{inputs.gone}}"}',
    );
  });
});

describe('describeStep for_each', () => {
  const fetch: WorkflowStep = { id: 'fetch', type: 'fetch_page', urls: ['https://a.example'] };
  const loop = (items: string): WorkflowStep => ({ id: 'each', type: 'for_each', items, steps: [] });
  const tt = (id: string, values?: Record<string, unknown>) => `${id.split('.').pop()} ${JSON.stringify(values)}`;

  it('names the step the loop reads and what one entry is', () => {
    expect(describeStep(loop('steps.fetch.pages'), tt, {}, {}, [fetch])).toBe('forEachFrom {"n":1,"kind":"page"}');
    expect(describeStep(loop('{{steps.fetch.stories}}'), tt, {}, {}, [fetch])).toBe('forEachFrom {"n":1,"kind":"story"}');
  });

  it('falls back to "item" for a list it has no name for', () => {
    expect(describeStep(loop('steps.fetch.things'), tt, {}, {}, [fetch])).toBe('forEachFrom {"n":1,"kind":"item"}');
  });

  it('keeps the plain wording when the list is not an earlier step', () => {
    expect(describeStep(loop('steps.gone.pages'), tt, {}, {}, [fetch])).toBe('forEach {"items":"steps.gone.pages"}');
    expect(describeStep(loop('inputs.urls'), tt)).toBe('forEach {"items":"inputs.urls"}');
  });
});

describe('describeStep branch', () => {
  const tt = (id: string, values?: Record<string, unknown>) => `${id.split('.').pop()} ${JSON.stringify(values)}`;
  it('reads as an "If" line with the value and text', () => {
    expect(describeStep({ id: 'b', type: 'branch', value: 'plain', is: 'contains', text: 'urgent' }, tt)).toBe(
      'contains {"value":"plain","text":"urgent"}',
    );
    expect(describeStep({ id: 'b', type: 'branch', value: 'x', is: 'empty' }, (id) => id)).toBe('workspace.workflows.step.branch.empty');
  });
});
