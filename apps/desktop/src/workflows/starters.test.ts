import { describe, expect, it } from 'vitest';
import type { WorkflowStep } from '../ipc/contracts';
import { STARTER_WORKFLOWS } from './starters';

const briefing = STARTER_WORKFLOWS.find((s) => s.id === 'briefing')!;

function forEachBody(): WorkflowStep[] {
  const loop = briefing.definition.steps.find((s) => s.type === 'for_each');
  if (!loop || loop.type !== 'for_each') throw new Error('no loop');
  return loop.steps;
}

describe('starters', () => {
  it('have unique ids and no condition syntax the engine lacks', () => {
    expect(new Set(STARTER_WORKFLOWS.map((s) => s.id)).size).toBe(STARTER_WORKFLOWS.length);
    expect(JSON.stringify(STARTER_WORKFLOWS)).not.toContain('{{#if');
  });

  it('briefing names every site before its summary, and a failed site keeps its section', () => {
    const body = forEachBody();
    expect(body.map((s) => s.id)).toEqual(['heading', 'summary']);
    const heading = body[0];
    // The heading comes from the page (url, error), not from the step that may be skipped.
    expect(heading.type === 'template' && heading.template).toContain('{{item.url}}');
    expect(heading.type === 'template' && heading.template).toContain('{{item.error}}');
    expect(body[1].onError).toBe('skip');
    // A dead site renders as a heading and its error with no extra blank lines: the
    // heading ends in one newline and the merge adds no separator before the summary.
    expect(heading.type === 'template' && heading.template).toBe('## {{item.url}}\n{{item.error}}');
    const summary = body[1];
    // Blank for a dead site (no title, no text), so the summary step refuses without a model call.
    expect(summary.type === 'summarize' && summary.input).toBe('{{item.title}}\n\n{{item.text}}');
    const merge = briefing.definition.steps.find((s) => s.id === 'briefing');
    const text = merge?.type === 'template' ? merge.template : '';
    expect(text.indexOf('{{item.heading.text}}')).toBeGreaterThan(-1);
    expect(text.indexOf('{{item.heading.text}}')).toBeLessThan(text.indexOf('{{item.summary.text}}'));
    // Only fields every output has: a skipped step writes `text`, a good one lacks `error`.
    expect(text).not.toContain('item.summary.error');
    expect(text).toContain('{{item.heading.text}}{{item.summary.text}}\n\n{{/each}}');
    expect(text).not.toContain('\n\n\n');
  });

  it('watch-a-page compares the fetched text and notifies only after the check', () => {
    const watch = STARTER_WORKFLOWS.find((s) => s.id === 'watch-page')!;
    const steps = watch.definition.steps;
    expect(steps.map((s) => s.type)).toEqual(['fetch_page', 'condition', 'summarize', 'save_artifact', 'notify']);
    expect(steps[1]).toEqual({ id: 'check', type: 'condition', value: '{{steps.fetch.text}}', is: 'changed' });
    // Every reference points at an input or an earlier step.
    const ids = new Set<string>();
    for (const step of steps) {
      for (const m of JSON.stringify(step).matchAll(/steps\.([a-z_]+)\./g)) expect(ids.has(m[1])).toBe(true);
      for (const m of JSON.stringify(step).matchAll(/inputs\.([a-z_]+)/g)) {
        expect(watch.definition.inputs?.some((i) => i.id === m[1])).toBe(true);
      }
      ids.add(step.id);
    }
  });
});
