/// The deck's words as a Markdown document ("Copy as Markdown"). Pure.

import type { DeckDetail } from '../ipc/contracts';
import { groupSlots } from './scriptBlocks';

const BREAK = '  \n';

/** Slot inline HTML to Markdown: strong/b -> **, em/i -> _, br -> a line break. */
export function inlineHtmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return node.nodeValue ?? '';
    if (node.nodeType !== 1) return '';
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') return BREAK;
    if (tag === 'style' || tag === 'script') return '';
    const inner = Array.from(el.childNodes).map(walk).join('');
    if (inner.trim() === '') return inner;
    if (tag === 'strong' || tag === 'b') return wrap('**', inner);
    if (tag === 'em' || tag === 'i') return wrap('_', inner);
    return inner;
  };
  return Array.from(doc.body.childNodes).map(walk).join('').replace(/(?:  \n)+$/, '').trim();
}

/** Keeps the markers hugging the words, so `**bold **` does not break. */
function wrap(mark: string, inner: string): string {
  const lead = inner.match(/^\s*/)?.[0] ?? '';
  const trail = inner.match(/\s*$/)?.[0] ?? '';
  return `${lead}${mark}${inner.trim()}${mark}${trail}`;
}

const indentContinuation = (s: string, pad: string) => s.replace(/\n/g, `\n${pad}`);

export function deckToMarkdown(deck: DeckDetail): string {
  const slides: string[] = [];
  deck.slides.forEach((slide, i) => {
    const blocks: string[] = [`## Slide ${i + 1}`];
    for (const item of groupSlots(slide.slots)) {
      if (item.type === 'list') {
        const lines = item.slots
          .map((s) => inlineHtmlToMarkdown(s.html))
          .filter((s) => s !== '')
          .map((s) => `- ${indentContinuation(s, '  ')}`);
        if (lines.length > 0) blocks.push(lines.join('\n'));
      } else if (item.type === 'figure') {
        const value = inlineHtmlToMarkdown(item.value.html);
        const caption = item.caption ? inlineHtmlToMarkdown(item.caption.html) : '';
        const bold = value === '' ? '' : value.startsWith('**') && value.endsWith('**') ? value : `**${value}**`;
        const line = [bold, caption].filter((s) => s !== '').join(' ');
        if (line !== '') blocks.push(line);
      } else {
        const text = inlineHtmlToMarkdown(item.slot.html);
        if (text === '') continue;
        switch (item.kind) {
          case 'kicker':
            blocks.push(`*${text}*`);
            break;
          case 'heading':
            blocks.push(`# ${text}`);
            break;
          case 'quote':
            blocks.push(`> ${indentContinuation(text, '> ')}`);
            break;
          case 'cite':
            blocks.push(`> — ${indentContinuation(text, '> ')}`);
            break;
          default:
            blocks.push(text);
        }
      }
    }
    const notes = slide.notes.trim();
    if (notes !== '') {
      const lines = notes.split(/\r?\n/);
      blocks.push(lines.map((l, n) => (n === 0 ? `> Notes: ${l}` : `> ${l}`)).join('\n'));
    }
    slides.push(blocks.join('\n\n'));
  });
  return slides.join('\n\n') + (slides.length > 0 ? '\n' : '');
}
