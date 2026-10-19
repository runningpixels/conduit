import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import de from '../i18n/messages/de.json';
import en from '../i18n/messages/en.json';
import type { Translate } from '../i18n';
import { KNOWN_COMPUTER_REASONS, translateComputerReason } from './computerReasons';

const workflowsRs = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src-tauri', 'src', 'workflows');
const rust = (file: string) => readFileSync(join(workflowsRs, file), 'utf8');

/** A minimal `t` over a catalog: `{name}` placeholders only, which is all these use. */
function tOf(catalog: Record<string, string>): Translate {
  return ((key: string, values?: Record<string, string>) =>
    (catalog[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => values?.[name] ?? `{${name}}`)) as never;
}
const tDe = tOf(de);
const tEn = tOf(en);

// Bug #10: in German, "No rule covers it." and "This workflow asks before
// changing files." stayed English on an otherwise translated card.
describe('computer-use reasons', () => {
  it('translates the reasons the backend sends', () => {
    expect(translateComputerReason('No rule covers it.', tDe)).toBe('Keine Regel deckt ihn ab.');
    expect(translateComputerReason('This workflow asks before changing files.', tDe)).toBe(
      'Dieser Workflow fragt nach, bevor er Dateien ändert.',
    );
    expect(translateComputerReason('It deletes files. Commands like this always ask.', tDe)).toBe(
      'Er löscht Dateien. Bei solchen Befehlen wird immer nachgefragt.',
    );
    expect(translateComputerReason('It matches your always-ask rule “git push *”.', tDe)).toBe(
      'Er passt zu deiner Immer-nachfragen-Regel „git push *“.',
    );
  });

  it('reads the same in English as the backend wrote it', () => {
    for (const reason of KNOWN_COMPUTER_REASONS) expect(translateComputerReason(reason, tEn)).toBe(reason);
    const deny = "It matches this workflow's always-ask rule “rm *”.";
    expect(translateComputerReason(deny, tEn)).toBe(deny);
  });

  it('shows a reason it does not know as sent', () => {
    expect(translateComputerReason('Something new.', tDe)).toBe('Something new.');
  });

  // The drift guard: every fixed reason in the Rust sources has a translation.
  it('knows every reason computer.rs and runner.rs can send', () => {
    const computer = rust('computer.rs');
    const start = computer.indexOf('fn built_in_reason');
    const end = computer.indexOf('pub fn suggested_rule');
    const region = computer.slice(start, end);
    const literals = [...region.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => m[1])
      .filter((s) => /^[A-Z][^{}]*\.$/.test(s));
    const runner = rust('runner.rs');
    literals.push(...[...runner.matchAll(/reason: "((?:[^"\\]|\\.)*)"\.to_string\(\)/g)].map((m) => m[1]));
    expect(literals.length).toBeGreaterThan(15);
    const missing = literals.filter((s) => !KNOWN_COMPUTER_REASONS.includes(s));
    expect(missing).toEqual([]);
  });
});
