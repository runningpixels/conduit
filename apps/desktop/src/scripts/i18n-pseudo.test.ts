import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import enMessages from '../i18n/messages/en.json';
import enXAMessages from '../i18n/messages/en-XA.json';
// Repo-root tooling script (Phase 1 i18n, docs/plans/localization.md). Plain
// ESM JS with no type bindings; vitest runs it directly. `@ts-ignore` keeps
// `tsc -b` (`pnpm check`) quiet about the missing declaration, the same
// precedent as generate-update-manifest.test.ts and apply-brand-identity.test.ts.
// @ts-ignore
import { ACCENT_MAP, accentLiteral, pseudoLocalizeMessage, REPO_ROOT } from '../../../../scripts/i18n-pseudo.mjs';

const repoRoot: string = REPO_ROOT;
const scriptPath = join(repoRoot, 'scripts', 'i18n-pseudo.mjs');

type Catalog = Record<string, string>;
const en = enMessages as Catalog;
const enXA = enXAMessages as Catalog;
const icu = { parse, TYPE };

/** Same placeholder walk as catalogs.test.ts, duplicated for the same reason the script duplicates it: no shared module between the TS app and the plain-JS script. */
function placeholders(message: string): Set<string> {
  const found = new Set<string>();
  walk(parse(message), found);
  return found;
}

function walk(elements: MessageFormatElement[], found: Set<string>): void {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        found.add(el.value);
        break;
      case TYPE.select:
      case TYPE.plural:
        found.add(el.value);
        for (const option of Object.values(el.options)) walk(option.value, found);
        break;
      default:
        break;
    }
  }
}

describe('i18n-pseudo: en-XA.json freshness (the gate that keeps the pseudo-locale honest)', () => {
  it('`node scripts/i18n-pseudo.mjs --check` exits 0 against the committed file', () => {
    expect(() =>
      execFileSync('node', [scriptPath, '--check'], { cwd: repoRoot, stdio: 'pipe' }),
    ).not.toThrow();
  });
});

describe('i18n-pseudo: committed en-XA.json is well-formed pseudo-ICU', () => {
  it('has exactly the same key set as en.json', () => {
    expect(Object.keys(enXA).sort()).toEqual(Object.keys(en).sort());
  });

  it('every message parses as ICU and keeps English\'s exact placeholder set', () => {
    for (const [key, value] of Object.entries(enXA)) {
      expect(() => parse(value), `${key} is not valid ICU: ${value}`).not.toThrow();
      const expected = [...placeholders(en[key])].sort();
      const actual = [...placeholders(value)].sort();
      expect(actual, `en-XA/${key} placeholder mismatch`).toEqual(expected);
    }
  });

  it('every message is bracket-wrapped and padded with em dashes', () => {
    for (const [key, value] of Object.entries(enXA)) {
      expect(value.startsWith('['), `${key} does not start with [`).toBe(true);
      expect(/—+\]$/.test(value), `${key} does not end with —…]`).toBe(true);
    }
  });

  it('recovery.discardBackup.deleted: ICU keywords and {count} survive untouched, and its literal text is accented', () => {
    const pseudo = enXA['recovery.discardBackup.deleted'];
    // The ICU control surface — none of this may be touched, or the message
    // stops parsing (`plural`, `one`, `other`) or stops binding the right
    // runtime value (`{count}`, `{freed}`).
    expect(pseudo).toContain('plural');
    expect(pseudo).toContain('one {');
    expect(pseudo).toContain('other {');
    expect(pseudo).toContain('{count');
    expect(pseudo).toContain('{freed}');
    // The literal text nested inside the plural arms ("backup file(s)") is
    // exactly what pseudo-localization exists to touch, including the arm
    // text — this is the AST-walk requirement, not just the top-level
    // literal segments.
    expect(pseudo).not.toContain('backup file');
    expect(pseudo).toContain('ḅàçķüṕ ḟîļé');
  });

  it('onboarding.actions.back is a short accented, bracket-wrapped, padded message', () => {
    const pseudo = enXA['onboarding.actions.back'];
    expect(pseudo).toBe(`[${accentLiteral('Back')}${'—'.repeat(Math.ceil('Back'.length * 0.4))}]`);
  });
});

describe('i18n-pseudo: ACCENT_MAP and accentLiteral', () => {
  it('maps every ASCII letter to a single-codepoint accented equivalent, and round-trips case', () => {
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
      const accented = ACCENT_MAP[letter];
      expect(accented, `no accent mapped for "${letter}"`).toBeTruthy();
      expect([...accented].length, `"${letter}" -> "${accented}" is not one codepoint`).toBe(1);
      expect([...accented.toUpperCase()].length, `uppercase of "${accented}" is not one codepoint`).toBe(1);
    }
  });

  it('accents every ASCII letter and leaves digits, spaces and punctuation untouched', () => {
    expect(accentLiteral('Save')).toBe(`${ACCENT_MAP.s.toUpperCase()}${ACCENT_MAP.a}${ACCENT_MAP.v}${ACCENT_MAP.e}`);
    expect(accentLiteral('# backup file')).toBe(`# ${ACCENT_MAP.b}${ACCENT_MAP.a}${ACCENT_MAP.c}${ACCENT_MAP.k}${ACCENT_MAP.u}${ACCENT_MAP.p} ${ACCENT_MAP.f}${ACCENT_MAP.i}${ACCENT_MAP.l}${ACCENT_MAP.e}`);
    // Non-letters — including the `{` `}` that would delimit an ICU
    // placeholder — pass through untouched. `accentLiteral` itself has no
    // ICU awareness at all: it is only ever called on spans the AST walk
    // has already proven are literal text, never on placeholder syntax.
    expect(accentLiteral('42 — …')).toBe('42 — …');
  });
});

describe('i18n-pseudo: pseudoLocalizeMessage (direct, on synthetic ICU)', () => {
  it('never touches an argument name, plural/select keywords, or #', () => {
    const message = '{n, plural, one {# widget} other {# widgets}} for {owner}';
    const pseudo = pseudoLocalizeMessage(message, icu);
    expect(pseudo).toContain('{n, plural, one {#');
    expect(pseudo).toContain('other {#');
    expect(pseudo).toContain('{owner}');
    // The arm's own literal text ("widget"/"widgets") must be accented.
    expect(pseudo).not.toContain('widget');
  });

  it('a message with no literal text at all still wraps cleanly with no padding', () => {
    const pseudo = pseudoLocalizeMessage('{value}', icu);
    expect(pseudo).toBe('[{value}]');
  });
});
