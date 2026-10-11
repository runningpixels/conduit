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

/** The field names a summarize step's schema requires of each story. */
function requiredStoryFields(step: WorkflowStep | undefined): string[] {
  if (step?.type !== 'summarize' || !step.schema) return [];
  const stories = (step.schema.properties as Record<string, { items?: { required?: string[] } }>).stories;
  return stories?.items?.required ?? [];
}

describe('starters', () => {
  it('have unique ids and no condition syntax the engine lacks', () => {
    expect(new Set(STARTER_WORKFLOWS.map((s) => s.id)).size).toBe(STARTER_WORKFLOWS.length);
    expect(JSON.stringify(STARTER_WORKFLOWS)).not.toContain('{{#if');
  });

  it('briefing picks stories from the front pages, reads each one and writes a dated document', () => {
    const steps = briefing.definition.steps;
    expect(steps.map((s) => s.type)).toEqual(['fetch_page', 'summarize', 'for_each', 'summarize', 'save_artifact']);
    // The pick sees each page's links, so it can name the article itself, not the front page.
    const pick = steps[1];
    expect(pick.type === 'summarize' && pick.input).toContain('{{item.linkText}}');
    expect(pick.type === 'summarize' && pick.schema).toBeTruthy();
    const loop = steps[2];
    expect(loop.type === 'for_each' && loop.items).toBe('steps.pick.data.stories');
    const body = forEachBody();
    expect(body.map((s) => s.id)).toEqual(['article', 'gist', 'card']);
    // A paywalled or dead link skips its own reading, never the run.
    expect(body.every((s) => s.onError === 'skip')).toBe(true);
    expect(body[0].type === 'fetch_page' && body[0].urls).toEqual(['{{item.url}}']);
    // The card reads only story fields the schema requires, so it always renders.
    const card = body[2];
    const fields = [...(card.type === 'template' ? card.template : '').matchAll(/\{\{item\.([a-z]+)\}\}/g)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) expect(requiredStoryFields(pick)).toContain(field);
    const write = steps[3];
    expect(write.type === 'summarize' && write.input).toBe('{{#each steps.read.items}}{{item.card.text}}\n\n{{/each}}');
    // A new document per run, so every briefing stays in Results.
    expect(steps[4]).toMatchObject({ type: 'save_artifact', mode: 'create', content: '{{steps.write.text}}' });
    expect(steps[4].type === 'save_artifact' && steps[4].title).toContain('{{run.date}}');
    // Every input the prompts read is one the user can set.
    for (const m of JSON.stringify(steps).matchAll(/inputs\.([a-z_]+)/g)) {
      expect(briefing.definition.inputs?.some((i) => i.id === m[1])).toBe(true);
    }
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
      // A loop's own steps are checked where they stand, so they may read
      // the loop steps before them.
      const check = (step: WorkflowStep, at: number[]) => {
        if (step.type === 'for_each') {
          step.steps.forEach((inner, i) => check(inner, [...at, i]));
          return;
        }
        const known = new Set(valuesAt(starter.definition, at).map((r) => r.path));
        for (const m of JSON.stringify(step).matchAll(/\{\{\s*([a-z0-9_.]+)\s*\}\}/g)) {
          if (m[1].startsWith('item') || m[1] === 'index') continue;
          expect(known.has(m[1]), `${starter.id}: ${m[1]}`).toBe(true);
        }
      };
      starter.definition.steps.forEach((step, index) => check(step, [index]));
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
