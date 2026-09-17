import { describe, expect, it } from 'vitest';
import { enTranslate } from '../test/enTranslate';
import { documentKindLabel } from './documentKind';

describe('documentKindLabel', () => {
  it('format names are do-not-translate literals', () => {
    expect(documentKindLabel('markdown', enTranslate)).toBe('Markdown');
    expect(documentKindLabel('html', enTranslate)).toBe('HTML');
    expect(documentKindLabel('json', enTranslate)).toBe('JSON');
  });
  it('code/text/image are translated ordinary words', () => {
    expect(documentKindLabel('code', enTranslate)).toBe('Code');
    expect(documentKindLabel('text', enTranslate)).toBe('Text');
    expect(documentKindLabel('image', enTranslate)).toBe('Image');
  });
  it('document falls back to the generic label', () => {
    expect(documentKindLabel('document', enTranslate)).toBe('Document');
  });
  it('an unrecognised kind is shown verbatim', () => {
    expect(documentKindLabel('whatever', enTranslate)).toBe('whatever');
  });
});
