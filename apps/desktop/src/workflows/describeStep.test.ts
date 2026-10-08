import { describe, expect, it } from 'vitest';
import { describeStep } from './describeStep';

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
