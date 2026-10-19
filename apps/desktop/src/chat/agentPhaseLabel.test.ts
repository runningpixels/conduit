import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import de from '../i18n/messages/de.json';
import type { Translate } from '../i18n';
import { localizeAgentPhase } from './agentPhaseLabel';

const tDe = ((key: string, values?: Record<string, unknown>) => {
  const text = (de as Record<string, string>)[key] ?? key;
  // Enough of ICU for the one plural these use.
  const count = values?.count as number | undefined;
  return count === undefined ? text : `${key}:${count}`;
}) as Translate;
const phase = (label: string) => ({ label, round: 1, subPhase: 'thinking' as const });

// Bug #9: Writing's assistant said "Writing the next section" in English in
// every language, and so did every phase the agent loop names.
describe('agent phase labels', () => {
  it('reads the backend’s phase names in the reader’s language', () => {
    expect(localizeAgentPhase(phase('Writing the next section'), tDe).label).toBe('Schreibt den nächsten Abschnitt…');
    expect(localizeAgentPhase(phase('Continuing'), tDe).label).toBe('Macht weiter…');
    expect(localizeAgentPhase(phase('Thinking'), tDe).label).toBe('Denkt nach…');
    expect(localizeAgentPhase(phase('Running 2 tools'), tDe).label).toBe('chat.view.agentPhase.runningTools:2');
    expect(localizeAgentPhase(phase('Running 1 tool'), tDe).label).toBe('chat.view.agentPhase.runningTools:1');
  });

  it('shows a label it does not know as sent', () => {
    const odd = phase('Something new');
    expect(localizeAgentPhase(odd, tDe)).toBe(odd);
  });

  // The drift guard: every phase name stream_manager.rs sends is translated.
  it('knows every phase label the agent loop sends', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src-tauri', 'src', 'stream_manager.rs'),
      'utf8',
    );
    const labels = new Set<string>();
    for (const m of source.matchAll(/next_round_label = Some\("([^"]+)"\)/g)) labels.add(m[1]);
    for (const m of source.matchAll(/label: "([^"]+)"\.to_string\(\)/g)) labels.add(m[1]);
    for (const m of source.matchAll(/unwrap_or\(if step == 0 \{ "([^"]+)" \} else \{ "([^"]+)" \}\)/g)) {
      labels.add(m[1]);
      labels.add(m[2]);
    }
    expect(labels.size).toBeGreaterThanOrEqual(6);
    const untranslated = [...labels].filter((label) => localizeAgentPhase(phase(label), tDe).label === label);
    expect(untranslated).toEqual([]);
    expect(source).toMatch(/"Running \{\} tool\{\}"/);
  });
});
