/**
 * Settings search: which sections hold a setting whose name matches a query.
 *
 * Built from the message catalog rather than from rendered sections, so a
 * section is searchable without being mounted, and a match is found in the
 * reader's own language. Only names are searched — labels, headings, section
 * titles — not help text or prose, which would match nearly any word and bury
 * the one row the reader meant.
 */

import type { Translate } from '../i18n';
import { EN_MESSAGES } from '../i18n';
import type { SettingsSection } from './SettingsSheet';

/**
 * Catalog key prefix → the section that renders it. Longest prefixes are not
 * needed: no prefix here is a prefix of another. settingsSearch.test.ts fails
 * if a `settings.*` area appears in the catalog without an entry, so a new
 * settings area cannot silently be left out of search.
 */
export const PREFIX_SECTIONS: readonly (readonly [string, SettingsSection])[] = [
  ['shell.settingsSheet.providers.', 'providers'],
  ['settings.provider.', 'providers'],
  ['shell.settingsSheet.chat.', 'chat'],
  ['settings.agent.', 'chat'],
  ['settings.generationControls.', 'chat'],
  ['shell.settingsSheet.webSearch.', 'web-search'],
  ['settings.webSearch.', 'web-search'],
  ['shell.settingsSheet.workspace.', 'workspace'],
  ['settings.workspaceTools.', 'workspace'],
  ['shell.settingsSheet.connectors.', 'connectors'],
  ['settings.connectors.', 'connectors'],
  ['shell.settingsSheet.prompts.', 'prompts'],
  ['settings.prompts.', 'prompts'],
  ['settings.variableFill.', 'prompts'],
  ['shell.settingsSheet.skills.', 'skills'],
  ['settings.skills.', 'skills'],
  ['shell.settingsSheet.memory.', 'memory'],
  ['settings.memory.', 'memory'],
  ['shell.settingsSheet.knowledge.', 'knowledge'],
  ['settings.knowledge.', 'knowledge'],
  ['shell.settingsSheet.appearance.', 'appearance'],
  ['settings.appearance.', 'appearance'],
  ['settings.branding.', 'branding'],
  ['shell.settingsSheet.privacy.', 'privacy'],
  ['settings.privacy.', 'privacy'],
  ['settings.artifactSecurity.', 'privacy'],
  ['settings.diagnostics.', 'privacy'],
  ['shell.settingsSheet.about.', 'about'],
  ['settings.about.', 'about'],
  ['settings.usage.', 'about'],
  ['settings.updates.', 'about'],
];

/** Catalog areas that are not a section's settings (the auto-save notice). */
export const UNSECTIONED_PREFIXES: readonly string[] = ['settings.autoSave.'];

/** A key names a setting when it is a label, heading or title… */
const NAME_KEY = /(\.|[a-z])(label|Label|heading|Heading|title)$/;
/** …and is not read-aloud-only, part of a dialog, or a placeholder. */
const NOT_A_NAME = /AriaLabel$|Dialog\.|dialog|consent\.|disclosure\.|confirmLabel$|placeholder/i;

export interface SettingsSearchEntry {
  key: string;
  section: SettingsSection;
}

function sectionFor(key: string): SettingsSection | undefined {
  return PREFIX_SECTIONS.find(([prefix]) => key.startsWith(prefix))?.[1];
}

/** Every searchable setting name, in catalog order. Computed once. */
export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = Object.entries(EN_MESSAGES)
  // A name with a placeholder ("{label} API key") is a template, not a name.
  .filter(([key, english]) => NAME_KEY.test(key) && !NOT_A_NAME.test(key) && !english.includes('{'))
  .flatMap(([key]) => {
    const section = sectionFor(key);
    return section ? [{ key, section }] : [];
  });

/**
 * Case-, accent- and width-insensitive form for matching. NFKD folds
 * full-width Latin (common in CJK input) as well as accents.
 */
export function foldForSearch(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .trim();
}

/**
 * Sections matching `query`, each with the names that matched, in nav order.
 * A section also matches on its own nav label.
 */
export function searchSettings(
  query: string,
  t: Translate,
  sections: readonly { id: SettingsSection; labelId: string }[],
): Map<SettingsSection, string[]> {
  const needle = foldForSearch(query);
  const result = new Map<SettingsSection, string[]>();
  if (!needle) return result;

  const names = new Map<SettingsSection, string[]>();
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    const name = t(entry.key);
    if (!foldForSearch(name).includes(needle)) continue;
    const list = names.get(entry.section) ?? [];
    if (!list.includes(name)) list.push(name);
    names.set(entry.section, list);
  }

  for (const section of sections) {
    const own = foldForSearch(t(section.labelId)).includes(needle);
    const found = names.get(section.id);
    if (own || found) result.set(section.id, found ?? []);
  }
  return result;
}
