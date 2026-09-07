import type { Translate } from '../i18n';

/**
 * The display name for a document kind.
 *
 * The five kinds split cleanly in two, and the split is the whole reason this
 * function exists instead of a lookup table:
 *
 *   - `Markdown`, `HTML` and `JSON` are format names. They are on the
 *     do-not-translate list (D7) and read identically in every locale we
 *     ship, so they are literals here and never reach a translator.
 *   - `code` and `text` are ordinary English words. Left as literals they sit
 *     untranslated in the middle of a translated sentence — "Dieses Dokument
 *     ist Code und…" — which is the exact seam a reader notices. German
 *     happens to borrow both words, so this buys nothing there; French
 *     ("Texte") and Japanese ("テキスト") are why it is worth doing before
 *     waves 2 and 3 rather than after.
 *
 * Three copies of the same map existed — `KIND_WORD` in `agentTools.ts` and a
 * `KIND_LABEL` in each of two components — which is how the two halves came to
 * be treated as one thing in the first place.
 */
export function documentKindLabel(kind: string, t: Translate): string {
  switch (kind) {
    case 'markdown':
      return 'Markdown';
    case 'html':
      return 'HTML';
    case 'json':
      return 'JSON';
    case 'code':
      return t('common.format.code');
    case 'text':
      return t('common.format.text');
    default:
      // An unrecognised kind is data from a tool call, not prose. Show it.
      return kind;
  }
}
