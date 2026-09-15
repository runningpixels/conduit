import { describe, expect, it } from 'vitest';
import { markPlaceholdersInHtml, markPlaceholdersInMarkdown, placeholderSections } from './documentBuild';

describe('placeholderSections', () => {
  it('finds section placeholders in order, whatever their case and spacing', () => {
    const html = '<main><!-- section: mercury -->\n  <!--SECTION:venus-->\n<!-- not a section --></main>';
    expect(placeholderSections(html)).toEqual(['mercury', 'venus']);
    expect(placeholderSections(undefined)).toEqual([]);
    expect(placeholderSections('<p>done</p>')).toEqual([]);
  });
});

describe('markPlaceholdersInHtml', () => {
  it('turns each placeholder into a visible block and escapes the label', () => {
    const shown = markPlaceholdersInHtml('<main><!-- section: "moons" & rings --></main>', (name) => `Not written yet: ${name}`);
    expect(shown).toContain('data-conduit-pending-section');
    expect(shown).toContain('Not written yet: &#34;moons&#34; &#38; rings');
    expect(shown).not.toContain('"moons"');
    expect(shown).not.toMatch(/<script/i);
  });

  it('leaves a finished document unchanged', () => {
    expect(markPlaceholdersInHtml('<p>done</p>', () => 'x')).toBe('<p>done</p>');
  });
});

describe('markPlaceholdersInMarkdown', () => {
  it('shows each placeholder as an emphasised line without markdown punctuation', () => {
    expect(markPlaceholdersInMarkdown('# Guide\n<!-- section: *moons* -->', (name) => `Not written yet: ${name}`)).toBe(
      '# Guide\n\n\n*Not written yet: moons*\n\n',
    );
  });
});
