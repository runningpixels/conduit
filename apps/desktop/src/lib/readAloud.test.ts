import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  pickVoice,
  readAloud,
  resetReadAloudForTests,
  speechChunks,
  speechLanguage,
  speechText,
  stopReadAloud,
} from './readAloud';

const voice = (lang: string, extra: Partial<SpeechSynthesisVoice> = {}) =>
  ({ lang, name: lang, default: false, localService: true, voiceURI: lang, ...extra }) as SpeechSynthesisVoice;

describe('speechText', () => {
  it('drops code blocks, link targets and markdown marks', () => {
    const md = [
      '# Title',
      'Some **bold** and *italic* with `code` and a [link](https://x.y).',
      '```ts',
      'const x = 1;',
      '```',
      '- item one',
      '> quoted',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
    ].join('\n');
    const out = speechText(md);
    expect(out).not.toMatch(/[#*`>]|https|const x|---/);
    expect(out).toContain('Title');
    expect(out).toContain('Some bold and italic with code and a link.');
    expect(out).toContain('item one');
    expect(out).toContain('quoted');
    expect(out).toContain('1 , 2');
  });

  it('keeps snake_case words intact', () => {
    expect(speechText('call my_tool_name now')).toBe('call my_tool_name now');
  });
});

describe('speechLanguage', () => {
  it('reads the script for Korean, Japanese and Chinese', () => {
    expect(speechLanguage('안녕하세요, 반갑습니다.', 'en')).toBe('ko');
    expect(speechLanguage('これは日本語の文章です。', 'en')).toBe('ja');
    expect(speechLanguage('这是一个中文句子。', 'en')).toBe('zh-CN');
    expect(speechLanguage('漢字', 'ja')).toBe('ja');
  });

  it('tells Latin-script languages apart by their common words', () => {
    expect(speechLanguage('The answer is that you need to restart it.', 'de')).toBe('en');
    expect(speechLanguage('Die Antwort ist, dass Sie es nicht mit der Hand tun.', 'en')).toBe('de');
    expect(speechLanguage('La respuesta es que los archivos están en el disco.', 'en')).toBe('es');
    expect(speechLanguage('La réponse est que vous devez redémarrer pour les fichiers.', 'en')).toBe('fr');
    expect(speechLanguage('A resposta é que você não precisa fazer isso com os arquivos.', 'en')).toBe('pt-BR');
  });

  it('falls back to the UI language, or English for a non-Latin UI', () => {
    expect(speechLanguage('OK', 'fr')).toBe('fr');
    expect(speechLanguage('OK', 'ja')).toBe('en');
  });
});

describe('pickVoice', () => {
  it('prefers the exact region, then the same language', () => {
    const voices = [voice('pt-PT'), voice('pt-BR'), voice('es-MX')];
    expect(pickVoice(voices, 'pt-BR')?.lang).toBe('pt-BR');
    expect(pickVoice(voices, 'es')?.lang).toBe('es-MX');
    expect(pickVoice(voices, 'de')).toBeUndefined();
  });

  it('matches underscore tags and prefers on-device voices', () => {
    const online = voice('en_US', { name: 'online', localService: false });
    const local = voice('en-US', { name: 'local' });
    expect(pickVoice([online, local], 'en-us')?.name).toBe('local');
  });
});

describe('speechChunks', () => {
  it('splits at sentence ends without exceeding the limit', () => {
    const text = 'One. Two two. Three three three!\n\nFour?';
    expect(speechChunks(text, 12)).toEqual(['One.', 'Two two.', 'Three three', 'three!', 'Four?']);
    expect(speechChunks(text)).toEqual(['One. Two two. Three three three!', 'Four?']);
  });
});

describe('readAloud', () => {
  afterEach(() => {
    resetReadAloudForTests();
    vi.unstubAllGlobals();
  });

  it('queues one utterance per chunk with the matching voice, and stop cancels', () => {
    const spoken: { text: string; voice: SpeechSynthesisVoice | null }[] = [];
    const de = voice('de-DE');
    const synth = {
      getVoices: () => [voice('en-US'), de],
      speak: (u: { text: string; voice: SpeechSynthesisVoice | null }) => spoken.push(u),
      cancel: vi.fn(),
      addEventListener: vi.fn(),
    };
    vi.stubGlobal('speechSynthesis', synth);
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        text: string;
        voice: SpeechSynthesisVoice | null = null;
        lang = '';
        constructor(text: string) {
          this.text = text;
        }
      },
    );
    readAloud('m1', 'Erster Satz. Zweiter Satz.', 'de');
    expect(spoken.map((u) => u.text)).toEqual(['Erster Satz. Zweiter Satz.']);
    expect(spoken[0]?.voice).toBe(de);

    stopReadAloud();
    expect(synth.cancel).toHaveBeenCalled();
  });

  it('speaks nothing when no voice matches', () => {
    const speak = vi.fn();
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [voice('en-US')],
      speak,
      cancel: vi.fn(),
      addEventListener: vi.fn(),
    });
    readAloud('m1', '안녕하세요.', 'ko');
    expect(speak).not.toHaveBeenCalled();
  });
});
