import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkflowDefinition, WorkflowStep } from '../ipc/contracts';
import { WorkflowEditor, type WorkflowDraft } from './WorkflowEditor';

/// Renders the editor with real state, and exposes the latest draft.
function renderEditor(definition: WorkflowDefinition) {
  const latest: { draft: WorkflowDraft } = { draft: { name: 'Test', description: '', definition } };
  function Harness() {
    const [draft, setDraft] = useState<WorkflowDraft>(latest.draft);
    latest.draft = draft;
    return <WorkflowEditor draft={draft} onChange={setDraft} />;
  }
  render(<Harness />);
  return latest;
}

const card = (name: RegExp) => screen.getByRole('listitem', { name }) as HTMLElement;

/// Type into a chip field (a contenteditable box): replace its text and fire
/// the input event the browser would.
function typeInto(field: HTMLElement, text: string) {
  field.textContent = text;
  fireEvent.input(field);
}


describe('WorkflowEditor', () => {
  it('builds fetch → ask the model → save, inserting values at the cursor', () => {
    const out = renderEditor({ inputs: [], steps: [] });

    // An input asked each run.
    fireEvent.click(screen.getByRole('button', { name: 'Add a value' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of value 1' }), { target: { value: 'Site' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Default for value 1' }), { target: { value: 'https://example.com' } });

    // Fetch the site.
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'fetch_page' } });
    const fetchCard = card(/^1\. Fetch pages/);
    fireEvent.change(within(fetchCard).getByRole('combobox', { name: 'Insert a value into Page 1' }), {
      target: { value: 'inputs.value' },
    });

    // Ask the model about it; the value goes where the cursor is.
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'summarize' } });
    const askCard = card(/^2\. Ask the model/);
    typeInto(within(askCard).getByRole('textbox', { name: 'Instruction' }), 'Summarize this');
    const input = within(askCard).getByRole('textbox', { name: 'Text to work on' });
    typeInto(input, 'Page: ');
    const caret = document.createRange();
    caret.setStart(input.firstChild!, 6);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(caret);
    fireEvent.keyUp(input);
    const insert = within(askCard).getByRole('combobox', { name: 'Insert a value into Text to work on' });
    // Only earlier steps are offered.
    const offered = within(insert).getAllByRole('option').map((o) => o.textContent);
    expect(offered).toEqual(expect.arrayContaining(['Site', "today's date", 'fetch · text', 'fetch · pages']));
    expect(offered.some((label) => label?.startsWith('summary'))).toBe(false);
    fireEvent.change(insert, { target: { value: 'steps.fetch.text' } });

    // Save the answer.
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'save_artifact' } });
    const saveCard = card(/^3\. Save a document/);
    typeInto(within(saveCard).getByRole('textbox', { name: 'Title' }), 'Summary');
    fireEvent.change(within(saveCard).getByRole('combobox', { name: 'Insert a value into Content' }), {
      target: { value: 'steps.summary.text' },
    });
    fireEvent.change(within(saveCard).getByRole('combobox', { name: 'Each run' }), { target: { value: 'create' } });

    expect(out.draft.definition).toEqual({
      inputs: [{ id: 'value', label: 'Site', default: 'https://example.com' }],
      steps: [
        { id: 'fetch', type: 'fetch_page', urls: ['{{inputs.value}}'] },
        { id: 'summary', type: 'summarize', prompt: 'Summarize this', input: 'Page: {{steps.fetch.text}}' },
        { id: 'save', type: 'save_artifact', title: 'Summary', content: '{{steps.summary.text}}', format: 'markdown', mode: 'create' },
      ],
    });
    // The inserted values show as chips with readable labels.
    expect(within(askCard).getByRole('textbox', { name: 'Text to work on' })).toHaveTextContent('Page: fetch · text×');
  });

  it('repeats steps for each item, offering the item fields inside', () => {
    const out = renderEditor({
      steps: [{ id: 'fetch', type: 'fetch_page', urls: ['https://example.com'] }],
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Add a step…' }), { target: { value: 'for_each' } });
    const loop = card(/^2\. Repeat for each/);
    fireEvent.change(within(loop).getByRole('combobox', { name: 'Repeat for each of' }), {
      target: { value: 'steps.fetch.pages' },
    });
    fireEvent.change(within(loop).getByRole('combobox', { name: 'Add a step to repeat…' }), { target: { value: 'template' } });
    const inner = within(loop).getByRole('listitem', { name: /^1\. Write text/ });
    const options = within(within(inner).getByRole('combobox', { name: 'Insert a value into Text' }))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['title', 'text', 'address', 'position in the list']));
    fireEvent.change(within(inner).getByRole('combobox', { name: 'Insert a value into Text' }), {
      target: { value: 'item.title' },
    });
    const loopStep = out.draft.definition.steps[1] as Extract<WorkflowStep, { type: 'for_each' }>;
    expect(loopStep).toMatchObject({ id: 'each', items: 'steps.fetch.pages' });
    expect(loopStep.steps).toEqual([{ id: 'text', type: 'template', template: '{{item.title}}' }]);
  });

  it('moves, removes and marks steps to keep going', () => {
    const out = renderEditor({
      steps: [
        { id: 'a', type: 'template', template: 'A' },
        { id: 'b', type: 'template', template: 'B' },
        { id: 'c', type: 'template', template: 'C' },
      ],
    });
    expect(screen.getByRole('button', { name: 'Move step 1 (Write text) up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move step 1 (Write text) down' }));
    expect(out.draft.definition.steps.map((s) => s.id)).toEqual(['b', 'a', 'c']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove step 3 (Write text)' }));
    expect(out.draft.definition.steps.map((s) => s.id)).toEqual(['b', 'a']);
    fireEvent.click(within(card(/^2\. Write text/)).getByRole('checkbox', { name: 'Keep going if this step fails' }));
    expect(out.draft.definition.steps[1]).toMatchObject({ id: 'a', onError: 'skip' });
  });

  it('keeps a summarize schema it cannot edit', () => {
    const schema = { type: 'object' };
    const out = renderEditor({ steps: [{ id: 's', type: 'summarize', prompt: 'p', input: 'i', schema }] });
    expect(screen.getByText(/Change the shape of that data in the JSON view/)).toBeInTheDocument();
    typeInto(screen.getByRole('textbox', { name: 'Instruction' }), 'new prompt');
    expect(out.draft.definition.steps[0]).toMatchObject({ prompt: 'new prompt', schema });
  });
});
