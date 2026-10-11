import { describe, expect, it } from 'vitest';
import { withInterfaceLanguage } from './starterLanguage';
import { STARTER_WORKFLOWS } from './starters';

const briefing = STARTER_WORKFLOWS.find((s) => s.id === 'briefing')!.definition;

const NAMES: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  fr: 'Français',
  ja: '日本語',
  ko: '한국어',
  'pt-BR': 'Português (Brasil)',
  'zh-CN': '简体中文',
};

describe('withInterfaceLanguage', () => {
  it.each(Object.entries(NAMES))('sets the language input for %s', (locale, name) => {
    const out = withInterfaceLanguage(briefing, locale);
    expect(out.inputs?.find((i) => i.id === 'language')?.default).toBe(name);
    expect(out.inputs?.filter((i) => i.id !== 'language')).toEqual(briefing.inputs?.filter((i) => i.id !== 'language'));
    expect(out.steps).toBe(briefing.steps);
  });

  it('leaves a starter without a language input alone', () => {
    const other = STARTER_WORKFLOWS.find((s) => !s.definition.inputs?.some((i) => i.id === 'language'));
    if (other) expect(withInterfaceLanguage(other.definition, 'de')).toBe(other.definition);
  });

  it('leaves the definition alone for an unknown locale', () => {
    expect(withInterfaceLanguage(briefing, 'xx')).toBe(briefing);
  });
});
