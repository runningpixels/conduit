/**
 * Read aloud: speaks a reply with the voices the operating system provides,
 * through the webview's `speechSynthesis`. Nothing is downloaded and nothing
 * leaves the machine.
 *
 * One reply speaks at a time. `useReadAloud` reports which one, so every
 * reply's button can show Stop while it is the one speaking.
 */
import { useEffect, useSyncExternalStore } from 'react';

/** Markdown turned into what a listener should hear: code blocks, tables'
 *  pipes, link targets, emphasis marks and image syntax are dropped. */
export function speechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/^\s*(\*\s*){3,}$/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'are', 'of', 'to', 'with', 'this', 'that', 'you', 'for', 'it'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'ein', 'eine', 'sie', 'ich', 'auf'],
  es: ['el', 'los', 'las', 'que', 'es', 'por', 'una', 'con', 'para', 'del', 'como', 'pero'],
  fr: ['le', 'les', 'des', 'est', 'une', 'et', 'pour', 'dans', 'pas', 'que', 'vous', 'avec'],
  'pt-BR': ['o', 'os', 'as', 'que', 'não', 'uma', 'com', 'para', 'do', 'da', 'você', 'em'],
};

/**
 * The language a text is written in, as one of the app's locale codes. The
 * script decides Korean, Japanese and Chinese; for Latin text the most common
 * function words decide, falling back to the UI language (or English when the
 * UI language isn't written in Latin script).
 */
export function speechLanguage(text: string, uiLocale: string): string {
  const sample = text.slice(0, 4000);
  const count = (re: RegExp) => sample.match(re)?.length ?? 0;
  const hangul = count(/[가-힯ᄀ-ᇿ]/g);
  const kana = count(/[぀-ヿ]/g);
  const han = count(/[一-鿿]/g);
  const latin = count(/[A-Za-zÀ-ɏ]/g);
  if (hangul > 0 && hangul >= kana && hangul * 2 >= latin) return 'ko';
  if (kana > 0 && (kana + han) * 2 >= latin) return 'ja';
  if (han > 0 && han * 2 >= latin) return uiLocale === 'ja' ? 'ja' : 'zh-CN';

  const words = sample.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  let best = '';
  let bestScore = 0;
  for (const [lang, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    const score = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  if (best && bestScore >= 2) return best;
  return uiLocale in STOPWORDS ? uiLocale : 'en';
}

/** Lowercased primary subtag: `pt-BR` → `pt`, `zh_CN` → `zh`. */
function primary(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0] ?? '';
}

function normalized(lang: string): string {
  return lang.toLowerCase().replace(/_/g, '-');
}

/**
 * The best installed voice for a language: an exact match first (pt-BR over
 * pt-PT), then any voice of the same language. Within either, the system
 * default and then on-device voices are preferred.
 */
export function pickVoice(
  voices: readonly SpeechSynthesisVoice[],
  lang: string,
): SpeechSynthesisVoice | undefined {
  const rank = (v: SpeechSynthesisVoice) => (v.default ? 0 : 1) + (v.localService ? 0 : 2);
  const sorted = [...voices].sort((a, b) => rank(a) - rank(b));
  return (
    sorted.find((v) => normalized(v.lang) === normalized(lang)) ??
    sorted.find((v) => primary(v.lang) === primary(lang))
  );
}

/**
 * Text split into pieces of at most `max` characters at sentence ends, so a
 * long reply is queued as several utterances. Some engines cut one long
 * utterance off part-way, and Stop is faster between short ones.
 */
export function speechChunks(text: string, max = 240): string[] {
  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？]*[ \t]*|\n+/g) ?? [];
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const sentence of sentences) {
    if (/^\n+$/.test(sentence)) {
      flush();
      continue;
    }
    if (current.length + sentence.length > max) flush();
    if (sentence.length > max) {
      for (let i = 0; i < sentence.length; i += max) chunks.push(sentence.slice(i, i + max).trim());
      continue;
    }
    current += sentence;
  }
  flush();
  return chunks.filter(Boolean);
}

// ── The shared controller ─────────────────────────────────────────────

interface ReadAloudState {
  supported: boolean;
  voices: readonly SpeechSynthesisVoice[];
  /** The reply being spoken, or null. */
  speakingId: string | null;
}

const listeners = new Set<() => void>();
let state: ReadAloudState = { supported: false, voices: [], speakingId: null };
let started = false;
/** Bumped on every speak/stop so callbacks from a cancelled run are ignored. */
let run = 0;

function synth(): SpeechSynthesis | undefined {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : undefined;
}

function set(next: Partial<ReadAloudState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function loadVoices() {
  const s = synth();
  if (!s) return;
  set({ supported: true, voices: s.getVoices() });
}

function start() {
  if (started) return;
  started = true;
  const s = synth();
  if (!s) return;
  loadVoices();
  // The list is often empty until the engine has enumerated its voices.
  s.addEventListener?.('voiceschanged', loadVoices);
}

/** Stop whatever is speaking. */
export function stopReadAloud() {
  run++;
  synth()?.cancel();
  if (state.speakingId !== null) set({ speakingId: null });
}

/** Speak `markdown` as reply `id` in `lang`, stopping anything else first. */
export function readAloud(id: string, markdown: string, lang: string) {
  const s = synth();
  if (!s) return;
  stopReadAloud();
  if (state.voices.length === 0) loadVoices();
  const voice = pickVoice(state.voices, lang);
  const chunks = speechChunks(speechText(markdown));
  if (!voice || chunks.length === 0) return;
  const mine = ++run;
  chunks.forEach((chunk, i) => {
    const u = new SpeechSynthesisUtterance(chunk);
    u.voice = voice;
    u.lang = voice.lang;
    if (i === chunks.length - 1) {
      u.onend = () => {
        if (run === mine) set({ speakingId: null });
      };
    }
    u.onerror = () => {
      if (run === mine) stopReadAloud();
    };
    s.speak(u);
  });
  set({ speakingId: id });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read-aloud state for one reply. Stops the speech if the reply unmounts
 *  while it is the one speaking. */
export function useReadAloud(id: string | undefined) {
  start();
  const snapshot = useSyncExternalStore(subscribe, () => state);
  useEffect(
    () => () => {
      if (id && state.speakingId === id) stopReadAloud();
    },
    [id],
  );
  return {
    supported: snapshot.supported && snapshot.voices.length > 0,
    speaking: !!id && snapshot.speakingId === id,
    hasVoice: (lang: string) => !!pickVoice(snapshot.voices, lang),
  };
}

/** Test seam: forget the shared state between tests. */
export function resetReadAloudForTests() {
  stopReadAloud();
  started = false;
  state = { supported: false, voices: [], speakingId: null };
}
