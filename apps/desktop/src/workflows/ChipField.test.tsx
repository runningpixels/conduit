import { createRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ChipField, type ChipFieldHandle } from './ChipField';
import { caretOffset } from './chipText';

const LABELS: Record<string, string> = {
  'inputs.site': 'Site',
  'steps.fetch.text': 'fetch · text',
  'run.date': "today's date",
};

/// A labelled chip field with real state; `latest.value` is the last change.
function renderField(initial: string, { multiline = false } = {}) {
  const latest = { value: initial };
  const handle = createRef<ChipFieldHandle>();
  let setOutside: (v: string) => void = () => {};
  function Harness() {
    const [value, setValue] = useState(initial);
    setOutside = setValue;
    latest.value = value;
    return (
      <>
        <span id="lbl">Text</span>
        <ChipField
          ref={handle}
          value={value}
          onChange={setValue}
          labelFor={(path) => LABELS[path] ?? null}
          removeLabel={(label) => `Remove ${label}`}
          multiline={multiline}
          labelledBy="lbl"
        />
      </>
    );
  }
  render(<Harness />);
  const field = screen.getByRole('textbox', { name: 'Text' });
  return { field, latest, handle, setOutside: (v: string) => act(() => setOutside(v)) };
}

const chips = (field: HTMLElement) =>
  Array.from(field.querySelectorAll<HTMLElement>('[data-ref]')).map((c) => ({
    path: c.dataset.ref,
    label: c.firstChild?.textContent,
    title: c.title,
  }));

describe('ChipField', () => {
  it('shows each reference as a labelled chip and keeps the rest as text', () => {
    const { field } = renderField('Page: {{steps.fetch.text}} on {{run.date}}');
    expect(chips(field)).toEqual([
      { path: 'steps.fetch.text', label: 'fetch · text', title: '{{steps.fetch.text}}' },
      { path: 'run.date', label: "today's date", title: '{{run.date}}' },
    ]);
    expect(field).toHaveTextContent("Page: fetch · text× on today's date×");
  });

  it('flags a reference that does not exist here', () => {
    const { field } = renderField('{{steps.gone.text}}');
    const chip = field.querySelector('[data-ref]') as HTMLElement;
    expect(chip).toHaveClass('wf-chip-unknown');
    expect(chip.firstChild?.textContent).toBe('steps.gone.text');
  });

  it('reports typing as template text, without rebuilding under the cursor', () => {
    const { field, latest } = renderField('Hi {{inputs.site}}');
    const chip = field.querySelector('[data-ref]');
    field.insertBefore(document.createTextNode('Oh, '), field.firstChild);
    fireEvent.input(field);
    expect(latest.value).toBe('Oh, Hi {{inputs.site}}');
    // The same chip element is still there: nothing was rebuilt.
    expect(field.querySelector('[data-ref]')).toBe(chip);
  });

  it('removes a chip with its × button', () => {
    const { field, latest } = renderField('A {{inputs.site}} B');
    fireEvent.click(within(field).getByRole('button', { name: 'Remove Site', hidden: true }));
    expect(latest.value).toBe('A  B');
    expect(chips(field)).toEqual([]);
  });

  it('inserts a reference at the last cursor position, or at the end', () => {
    const { field, latest, handle } = renderField('Before after');
    const text = field.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 7);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyUp(field);
    act(() => handle.current!.insert('steps.fetch.text'));
    expect(latest.value).toBe('Before {{steps.fetch.text}}after');

    window.getSelection()!.removeAllRanges();
    cleanup();
    const fresh = renderField('End: ');
    act(() => fresh.handle.current!.insert('run.date'));
    expect(fresh.latest.value).toBe('End: {{run.date}}');
  });

  it('rebuilds when the value changes from outside', () => {
    const { field, setOutside } = renderField('one');
    setOutside('two {{inputs.site}}');
    expect(chips(field).map((c) => c.path)).toEqual(['inputs.site']);
    expect(field).toHaveTextContent('two Site×');
  });

  it('pastes plain text, and a pasted reference becomes a chip', () => {
    const { field, latest } = renderField('');
    const clipboardData = { getData: vi.fn(() => 'see {{inputs.site}}\nnow') };
    fireEvent.paste(field, { clipboardData });
    // A single-line field folds the line break into a space.
    expect(latest.value).toBe('see {{inputs.site}} now');
    expect(chips(field).map((c) => c.label)).toEqual(['Site']);
  });

  it('turns a reference into a chip as soon as it is typed, keeping the cursor after it', () => {
    const { field, latest } = renderField('Go ');
    field.focus();
    const text = field.firstChild as Text;
    text.data = 'Go {{run.date}} now';
    const range = document.createRange();
    range.setStart(text, 'Go {{run.date}}'.length);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyUp(field);
    fireEvent.input(field);
    expect(latest.value).toBe('Go {{run.date}} now');
    expect(chips(field).map((c) => c.label)).toEqual(["today's date"]);
    // The cursor is right after the new chip, where the typing left it.
    const caret = window.getSelection()!.getRangeAt(0);
    expect(caretOffset(field, caret)).toBe('Go {{run.date}}'.length);
  });

  it('adds a line on Enter only when multi-line', () => {
    const single = renderField('a');
    fireEvent.keyDown(single.field, { key: 'Enter' });
    expect(single.latest.value).toBe('a');
    cleanup();

    const multi = renderField('a', { multiline: true });
    fireEvent.keyDown(multi.field, { key: 'Enter' });
    expect(multi.latest.value).toBe('a\n');
  });
});
