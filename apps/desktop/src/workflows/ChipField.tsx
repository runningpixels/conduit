/// A text field that shows `{{…}}` references as chips.
///
/// The value stays plain template text (`Page: {{steps.fetch.text}}`), which is
/// what the backend runs. On screen each reference is an atomic chip with a
/// readable label ("fetch · text"); the raw reference is its tooltip. Chips
/// can't be edited inside, Backspace removes one whole, and each has a × for
/// the mouse.
///
/// The editable DOM is managed here, not by React: rebuilding it on every
/// keystroke would lose the cursor. It is rebuilt only when the value changes
/// from outside (the JSON view, a reset), when typed, pasted or inserted text
/// now holds a new reference (it becomes a chip at once), or when a chip's
/// label changes. A rebuild while the field has focus puts the cursor back at
/// the same place in the text. Paste inserts plain text only. Enter adds a
/// line only in multi-line fields.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { caretOffset, countRefs, parseSegments, rangeAtOffset, serializeChipDom } from './chipText';

export interface ChipFieldHandle {
  /// Insert a reference at the last cursor position (the end if there was none).
  insert(path: string): void;
}

interface ChipFieldProps {
  value: string;
  onChange: (value: string) => void;
  /// Readable label for a reference, or `null` if nothing by that name exists here.
  labelFor: (path: string) => string | null;
  /// Accessible name for the "remove" button on a chip.
  removeLabel: (chipLabel: string) => string;
  multiline?: boolean;
  labelledBy: string;
}

function makeChip(path: string, labelFor: ChipFieldProps['labelFor'], removeLabel: ChipFieldProps['removeLabel']) {
  const label = labelFor(path);
  const chip = document.createElement('span');
  chip.className = label ? 'wf-chip' : 'wf-chip wf-chip-unknown';
  chip.contentEditable = 'false';
  chip.dataset.ref = path;
  chip.title = `{{${path}}}`;
  const text = document.createElement('span');
  text.dataset.chipPart = '';
  text.textContent = label ?? path;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.tabIndex = -1;
  remove.dataset.chipPart = '';
  remove.dataset.remove = '';
  remove.className = 'wf-chip-remove';
  remove.setAttribute('aria-label', removeLabel(label ?? path));
  remove.textContent = '×';
  chip.append(text, remove);
  return chip;
}

export const ChipField = forwardRef<ChipFieldHandle, ChipFieldProps>(function ChipField(
  { value, onChange, labelFor, removeLabel, multiline = false, labelledBy },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const labelsRef = useRef({ labelFor, removeLabel });
  labelsRef.current = { labelFor, removeLabel };

  const build = useCallback(
    (text: string) => {
      const root = rootRef.current;
      if (!root) return;
      const focused = document.activeElement === root;
      const saved = savedRange.current;
      const offset = saved && root.contains(saved.startContainer) ? caretOffset(root, saved) : null;
      root.replaceChildren();
      for (const segment of parseSegments(text)) {
        root.append(
          segment.kind === 'text'
            ? document.createTextNode(segment.text)
            : makeChip(segment.path, labelsRef.current.labelFor, labelsRef.current.removeLabel),
        );
      }
      // Lets the cursor sit on a trailing empty line in a multi-line field.
      if (multiline) {
        const sentinel = document.createElement('br');
        sentinel.dataset.sentinel = '';
        root.append(sentinel);
      }
      savedRange.current = null;
      if (offset != null) {
        const range = rangeAtOffset(root, Math.min(offset, text.length));
        savedRange.current = range.cloneRange();
        const selection = window.getSelection();
        if (focused && selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    },
    [multiline],
  );

  // Rebuild when the value differs from what the DOM holds, or when a chip's
  // label would read differently (an input was renamed, say).
  const labelsKey = parseSegments(value)
    .filter((s) => s.kind === 'ref')
    .map((s) => (s.kind === 'ref' ? `${s.path}=${labelFor(s.path) ?? ''}` : ''))
    .join('|');
  const builtLabelsKey = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (serializeChipDom(root) !== value || builtLabelsKey.current !== labelsKey) {
      build(value);
      builtLabelsKey.current = labelsKey;
    }
  }, [value, labelsKey, build]);

  const emit = () => {
    const root = rootRef.current;
    if (root) onChangeRef.current(serializeChipDom(root));
  };

  const saveRange = () => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (root.contains(range.startContainer)) savedRange.current = range.cloneRange();
  };

  /// Put `node` where the cursor was (replacing any selected text), then the
  /// cursor after it.
  const insertNode = (node: Node) => {
    const root = rootRef.current;
    if (!root) return;
    let range = savedRange.current;
    if (!range || !root.contains(range.startContainer)) {
      range = document.createRange();
      const sentinel = root.querySelector('br[data-sentinel]');
      if (sentinel) range.setStartBefore(sentinel);
      else range.selectNodeContents(root);
      range.collapse(sentinel == null ? false : true);
    }
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    savedRange.current = range.cloneRange();
    const selection = window.getSelection();
    if (selection && document.activeElement === root) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };

  useImperativeHandle(ref, () => ({
    insert(path: string) {
      insertNode(makeChip(path, labelsRef.current.labelFor, labelsRef.current.removeLabel));
      emit();
    },
  }));

  // The cursor moves without an event on the field itself (arrow keys, clicks
  // between chips); keep the last position that was inside it.
  useEffect(() => {
    const onSelection = () => saveRange();
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, []);

  return (
    <div
      ref={rootRef}
      className={multiline ? 'mem-input wf-chip-field wf-chip-field-multi' : 'mem-input wf-chip-field'}
      role="textbox"
      aria-multiline={multiline}
      aria-labelledby={labelledBy}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      onInput={emit}
      onKeyUp={saveRange}
      onMouseUp={saveRange}
      onBlur={() => {
        saveRange();
        const root = rootRef.current;
        // Typed or pasted `{{…}}` becomes a chip once the field is left.
        if (root && countRefs(serializeChipDom(root)) !== root.querySelectorAll('[data-ref]').length) {
          build(serializeChipDom(root));
        }
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (!multiline) return;
        saveRange();
        insertNode(document.createTextNode('\n'));
        emit();
      }}
      onPaste={(e) => {
        e.preventDefault();
        let text = e.clipboardData.getData('text/plain');
        if (!multiline) text = text.replace(/\s*\n\s*/g, ' ');
        if (!text) return;
        saveRange();
        insertNode(document.createTextNode(text));
        emit();
      }}
      onClick={(e) => {
        const remove = (e.target as HTMLElement).closest('[data-remove]');
        const chip = remove?.closest('[data-ref]');
        if (!chip) return;
        e.preventDefault();
        chip.remove();
        savedRange.current = null;
        emit();
      }}
    />
  );
});
