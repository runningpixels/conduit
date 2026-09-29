/// Template text ⇄ chips. A step field stores plain text with `{{path}}`
/// references (the backend's template syntax); the editor shows each
/// reference as a chip. These helpers convert between the two, and read the
/// text back out of the editable DOM (`ChipField`).

export type Segment = { kind: 'text'; text: string } | { kind: 'ref'; path: string };

/// A reference as the backend accepts it: dotted segments of `[A-Za-z0-9_-]`.
const REF = /\{\{\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;

/// Split template text into plain text and references. Anything that isn't a
/// well-formed reference (`{{#each …}}`, a lone `{{`) stays text.
export function parseSegments(value: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of value.matchAll(REF)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: 'text', text: value.slice(last, start) });
    segments.push({ kind: 'ref', path: match[1] });
    last = start + match[0].length;
  }
  if (last < value.length) segments.push({ kind: 'text', text: value.slice(last) });
  return segments;
}

export function joinSegments(segments: readonly Segment[]): string {
  return segments.map((s) => (s.kind === 'text' ? s.text : `{{${s.path}}}`)).join('');
}

/// How many references `value` holds.
export function countRefs(value: string): number {
  return parseSegments(value).filter((s) => s.kind === 'ref').length;
}

/// A `<br>` the browser adds at the end of an editable box to keep an empty
/// line open (Chromium does after a delete). It isn't text the user typed:
/// Enter inserts `\n` as text (`ChipField`), never a `<br>`.
function isTrailingPlaceholder(br: HTMLElement): boolean {
  for (let next = br.nextSibling; next; next = next.nextSibling) {
    if (next instanceof HTMLElement && next.dataset.sentinel != null) continue;
    if (next.nodeType === Node.TEXT_NODE && (next as Text).data === '') continue;
    return false;
  }
  return true;
}

/// The template text an editable chip field holds. Chips (`[data-ref]`) are
/// their `{{path}}`; `<br>` and block elements (which a browser may add on
/// Enter) are line breaks; the trailing sentinel `<br>` is ignored.
export function serializeChipDom(root: Node): string {
  let out = '';
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += (child as Text).data;
      } else if (child instanceof HTMLElement) {
        if (child.dataset.ref) {
          out += `{{${child.dataset.ref}}}`;
        } else if (child.tagName === 'BR') {
          if (child.dataset.sentinel == null && !isTrailingPlaceholder(child)) out += '\n';
        } else if (child.tagName === 'DIV' || child.tagName === 'P') {
          if (out.length > 0 && !out.endsWith('\n')) out += '\n';
          walk(child);
        } else if (child.dataset.chipPart == null) {
          walk(child);
        }
      }
    }
  };
  walk(root);
  return out;
}

/// How much template text a DOM node stands for: a chip is its `{{path}}`, a
/// line break one character, the sentinel nothing.
function nodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length;
  if (node instanceof HTMLElement) {
    if (node.dataset.ref) return node.dataset.ref.length + 4;
    if (node.tagName === 'BR') return node.dataset.sentinel == null ? 1 : 0;
    return serializeChipDom(node).length;
  }
  return 0;
}

/// Where `range` starts, as an offset into the field's template text.
export function caretOffset(root: HTMLElement, range: Range): number {
  const { startContainer, startOffset } = range;
  let offset = 0;
  for (const child of Array.from(root.childNodes)) {
    if (startContainer === root && root.childNodes[startOffset] === child) return offset;
    if (child === startContainer || child.contains(startContainer)) {
      // Inside a text node: count to the cursor. Inside a chip: after it.
      return offset + (child.nodeType === Node.TEXT_NODE ? startOffset : nodeLength(child));
    }
    offset += nodeLength(child);
  }
  return offset;
}

/// A collapsed range at `target` in the field's template text. A position
/// inside a chip lands just after it; past the end lands at the end.
export function rangeAtOffset(root: HTMLElement, target: number): Range {
  const range = document.createRange();
  let offset = 0;
  for (const child of Array.from(root.childNodes)) {
    const length = nodeLength(child);
    if (child.nodeType === Node.TEXT_NODE) {
      if (target <= offset + length) {
        range.setStart(child, target - offset);
        return range;
      }
    } else if (length > 0 && target < offset + length) {
      if (target === offset) range.setStartBefore(child);
      else range.setStartAfter(child);
      return range;
    }
    offset += length;
  }
  const sentinel = root.querySelector('br[data-sentinel]');
  if (sentinel) {
    range.setStartBefore(sentinel);
  } else {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  return range;
}
