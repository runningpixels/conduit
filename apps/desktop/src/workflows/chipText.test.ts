import { describe, expect, it } from 'vitest';
import { caretOffset, countRefs, joinSegments, parseSegments, rangeAtOffset, serializeChipDom } from './chipText';

describe('parseSegments / joinSegments', () => {
  it('splits text and references and joins them back', () => {
    const value = 'Hello {{inputs.name}}, today is {{ run.date }}!';
    const segments = parseSegments(value);
    expect(segments).toEqual([
      { kind: 'text', text: 'Hello ' },
      { kind: 'ref', path: 'inputs.name' },
      { kind: 'text', text: ', today is ' },
      { kind: 'ref', path: 'run.date' },
      { kind: 'text', text: '!' },
    ]);
    // Whitespace inside the braces is normalized away; everything else survives.
    expect(joinSegments(segments)).toBe('Hello {{inputs.name}}, today is {{run.date}}!');
    expect(countRefs(value)).toBe(2);
  });

  it('keeps anything that is not a plain reference as text', () => {
    const value = '{{#each steps.a.items}}- {{item.title}}\n{{/each}} {{ broken';
    expect(parseSegments(value)).toEqual([
      { kind: 'text', text: '{{#each steps.a.items}}- ' },
      { kind: 'ref', path: 'item.title' },
      { kind: 'text', text: '\n{{/each}} {{ broken' },
    ]);
    expect(parseSegments('')).toEqual([]);
    expect(parseSegments('{{steps.fetch.pages.0.title}}')).toEqual([{ kind: 'ref', path: 'steps.fetch.pages.0.title' }]);
  });
});

describe('caretOffset / rangeAtOffset', () => {
  function field() {
    const root = document.createElement('div');
    root.innerHTML = 'ab<span data-ref="run.date"><span data-chip-part="">date</span></span>cd<br data-sentinel="">';
    return root;
  }

  it('counts a chip as its full {{…}} text', () => {
    const root = field();
    const inText = document.createRange();
    inText.setStart(root.childNodes[2], 1); // "c|d"
    expect(caretOffset(root, inText)).toBe(2 + '{{run.date}}'.length + 1);
    const inChip = document.createRange();
    inChip.setStart(root.childNodes[1].firstChild!, 0);
    expect(caretOffset(root, inChip)).toBe(2 + '{{run.date}}'.length);
    const between = document.createRange();
    between.setStart(root, 1);
    expect(caretOffset(root, between)).toBe(2);
  });

  it('maps an offset back, landing after a chip it falls inside', () => {
    const root = field();
    const chip = root.childNodes[1];
    const before = rangeAtOffset(root, 2);
    expect([before.startContainer, before.startOffset]).toEqual([root.childNodes[0], 2]);
    const inside = rangeAtOffset(root, 5);
    expect([inside.startContainer, inside.startOffset]).toEqual([root, Array.from(root.childNodes).indexOf(chip) + 1]);
    const after = rangeAtOffset(root, 2 + '{{run.date}}'.length + 1);
    expect([after.startContainer, after.startOffset]).toEqual([root.childNodes[2], 1]);
    const end = rangeAtOffset(root, 999);
    expect(end.startContainer).toBe(root);
    expect(root.childNodes[end.startOffset]).toBe(root.querySelector('br'));
  });
});

describe('serializeChipDom', () => {
  it('reads chips, text, breaks and blocks back into template text', () => {
    const root = document.createElement('div');
    root.innerHTML =
      'Title: <span data-ref="steps.fetch.pages.0.title" contenteditable="false"><span data-chip-part="">first title</span><button data-chip-part="">×</button></span>' +
      '<br>Body<div>next line <span data-ref="steps.summary.text"><span data-chip-part="">summary</span></span></div><br data-sentinel="">';
    expect(serializeChipDom(root)).toBe('Title: {{steps.fetch.pages.0.title}}\nBody\nnext line {{steps.summary.text}}');
  });

  it("ignores the placeholder <br> a browser leaves at the end after a delete", () => {
    // Seen live in WebView2: Backspace over the last chip left `# <br>`.
    const root = document.createElement('div');
    root.innerHTML = '# <br><br data-sentinel="">';
    expect(serializeChipDom(root)).toBe('# ');
    // A line break in the middle is still a line break.
    root.innerHTML = 'a<br>b<br>';
    expect(serializeChipDom(root)).toBe('a\nb');
  });
});
