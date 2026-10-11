import { localeEntry } from '../i18n';
import type { WorkflowDefinition } from '../ipc/contracts';

/**
 * A starter with a `language` input (the briefing) writes in the interface
 * language, so its default becomes that language's own name. Any other
 * starter comes back untouched.
 */
export function withInterfaceLanguage(definition: WorkflowDefinition, locale: string): WorkflowDefinition {
  const name = localeEntry(locale)?.nativeName;
  if (!name || !definition.inputs?.some((input) => input.id === 'language')) return definition;
  return {
    ...definition,
    inputs: definition.inputs.map((input) => (input.id === 'language' ? { ...input, default: name } : input)),
  };
}
