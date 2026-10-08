import { describe, expect, it } from 'vitest';
import type { WorkflowStep } from '../ipc/contracts';
import { documentTarget, isDocumentEdit, needsCollections, needsDocumentTarget, triggerNeedsFolder, valuesAt } from './editorModel';
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

  it('weekly numbers deck reads a CSV table and updates a deck the user still has to pick', () => {
    const starter = STARTER_WORKFLOWS.find((x) => x.id === 'weekly-numbers-deck')!;
    const steps = starter.definition.steps;
    expect(steps.map((x) => x.type)).toEqual(['fetch_page', 'parse_data', 'edit_deck']);
    expect(steps[1]).toMatchObject({ type: 'parse_data', input: '{{steps.fetch.pages.0.text}}', format: 'csv' });
    const edit = steps[2];
    expect(edit).toMatchObject({ type: 'edit_deck', deck: '', input: '{{steps.data.text}}' });
    expect(edit.type === 'edit_deck' && edit.instructions).toMatch(/chart/);
    // Nothing is chosen for the user: the editor flags the empty deck.
    expect(needsDocumentTarget(starter.definition)).toBe(true);
  });

  it('monthly report section fetches, summarizes and adds a section to a draft the user still has to pick', () => {
    const starter = STARTER_WORKFLOWS.find((x) => x.id === 'monthly-report-section')!;
    const steps = starter.definition.steps;
    expect(steps.map((x) => x.type)).toEqual(['fetch_page', 'summarize', 'edit_draft']);
    expect(steps[2]).toMatchObject({ type: 'edit_draft', draft: '', input: '{{steps.summary.text}}' });
    expect(needsDocumentTarget(starter.definition)).toBe(true);
  });

  it('weekly research digest researches, updates one document and notifies', () => {
    const starter = STARTER_WORKFLOWS.find((x) => x.id === 'weekly-research-digest')!;
    const steps = starter.definition.steps;
    expect(steps.map((x) => x.type)).toEqual(['research', 'save_artifact', 'notify']);
    expect(steps[0]).toMatchObject({ depth: 'quick', question: '{{inputs.topic}}: what changed this week?' });
    expect(steps[1]).toMatchObject({ mode: 'update', content: '{{steps.research.text}}' });
    expect(needsCollections(starter.definition)).toBe(false);
  });

  it('check notes against my docs reads, searches, summarizes and saves, with collections still to pick', () => {
    const starter = STARTER_WORKFLOWS.find((x) => x.id === 'check-notes-against-docs')!;
    const steps = starter.definition.steps;
    expect(steps.map((x) => x.type)).toEqual(['read_file', 'search_documents', 'summarize', 'save_artifact']);
    expect(steps[1]).toMatchObject({ collections: [], query: '{{steps.notes.text}}' });
    // Nothing is chosen for the user: the editor opens so they pick the collections.
    expect(needsCollections(starter.definition)).toBe(true);
  });

  it('every other starter can be saved as it is, and every reference in the new ones resolves', () => {
    for (const starter of STARTER_WORKFLOWS) {
      const edits = starter.definition.steps.filter(isDocumentEdit);
      expect(needsDocumentTarget(starter.definition)).toBe(edits.some((e) => documentTarget(e) === ''));
      // Documents are never chosen on the user's behalf.
      for (const e of edits) expect(documentTarget(e)).toBe('');
      starter.definition.steps.forEach((step, index) => {
        const known = new Set(valuesAt(starter.definition, [index]).map((r) => r.path));
        for (const m of JSON.stringify(step).matchAll(/\{\{\s*([a-z0-9_.]+)\s*\}\}/g)) {
          if (m[1].startsWith('item') || m[1] === 'index') continue;
          expect(known.has(m[1]), `${starter.id}: ${m[1]}`).toBe(true);
        }
      });
    }
  });

  it('new posts digest starts from a feed, and inbox folder from a folder the user still has to pick', () => {
    const posts = STARTER_WORKFLOWS.find((x) => x.id === 'new-posts-digest')!;
    expect(posts.definition.trigger).toMatchObject({ kind: 'feed', everyMinutes: 30 });
    expect(posts.definition.steps.map((x) => x.type)).toEqual(['fetch_page', 'summarize', 'save_artifact', 'notify']);
    expect(posts.definition.steps[0]).toMatchObject({ urls: ['{{trigger.link}}'] });
    expect(posts.definition.steps[2]).toMatchObject({ mode: 'create' });
    expect(triggerNeedsFolder(posts.definition)).toBe(false);

    const inbox = STARTER_WORKFLOWS.find((x) => x.id === 'inbox-folder')!;
    expect(inbox.definition.trigger).toEqual({ kind: 'folder' });
    expect(inbox.definition.steps.map((x) => x.type)).toEqual(['read_file', 'summarize', 'export_file', 'notify']);
    expect(inbox.definition.steps[0]).toMatchObject({ path: '{{trigger.path}}' });
    // The export keeps the source's own extension out of the way: "list2.txt summary.md", never "summary-list2.txt.md".
    const exportStep = inbox.definition.steps[2];
    expect(exportStep.type === 'export_file' && exportStep.name).toBe('{{trigger.name}} summary.md');
    // Nothing is chosen for the user: the editor opens so they pick the folder.
    expect(triggerNeedsFolder(inbox.definition)).toBe(true);
  });
});
