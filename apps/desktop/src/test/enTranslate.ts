import { EN_MESSAGES, createAppIntl, translate, type Translate } from '../i18n';

/**
 * A `Translate` bound to the real English catalog.
 *
 * For testing the plain functions that take `t` as a parameter because they
 * are not components and cannot call the hook — `explainToolError` is the
 * first, and the pattern recurs wherever a helper has to produce a sentence.
 *
 * Bound to the real `en.json` rather than a stub on purpose: a stub would let
 * a test keep passing after its message was deleted from the catalog, which
 * is precisely the drift the catalog exists to prevent.
 */
const intl = createAppIntl('en', EN_MESSAGES);

export const enTranslate: Translate = (id, values) => translate(intl, id, values);
