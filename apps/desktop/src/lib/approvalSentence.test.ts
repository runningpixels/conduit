import { describe, expect, it } from 'vitest';
import { createAppIntl, translate, type Translate } from '../i18n';
import de from '../i18n/messages/de.json';
import en from '../i18n/messages/en.json';
import {
  APPROVAL_COMMAND_MAX_CHARS,
  APPROVAL_NAME_MAX_CHARS,
  computerApprovalSubject,
  describeApproval,
  type ApprovalSubject,
} from './approvalSentence';
import type { ComputerRequest } from '../ipc/contracts';

/** The real English catalog, so the test reads the sentence a person would. */
function translateWith(messages: Record<string, string>, locale: string): Translate {
  const intl = createAppIntl(locale, messages);
  return (id, values) => translate(intl, id, values);
}
const t = translateWith(en as Record<string, string>, 'en');
const size = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;
const say = (s: ApprovalSubject) => describeApproval(s, t, size);

describe('describeApproval', () => {
  it('runs a command in a folder, naming the program without its extension', () => {
    expect(
      say({
        kind: 'run_command',
        program: String.raw`C:\Program Files\nodejs\npm.cmd`,
        args: ['test'],
        folder: String.raw`C:\work\ferry`,
        path: '.',
      }),
    ).toBe('Run “npm test” in ferry');
  });

  it('adds the inner folder and quotes arguments with spaces', () => {
    expect(
      say({ kind: 'run_command', program: '/usr/bin/git', args: ['commit', '-m', 'fix the build'], folder: '/work/ferry', path: 'src/app' }),
    ).toBe('Run “git commit -m "fix the build"” in ferry/src/app');
  });

  it('writes a new file with its size', () => {
    expect(say({ kind: 'write_file', path: 'report.md', folder: String.raw`C:\Users\ana\Documents`, content: 'x'.repeat(2150) })).toBe(
      'Write report.md (2.1 KB) in Documents',
    );
  });

  it('replaces a file that exists', () => {
    expect(say({ kind: 'write_file', path: 'notes/a.txt', folder: '/work/site', content: 'new', previous: 'old' })).toBe(
      'Replace notes/a.txt (0.0 KB) in site',
    );
  });

  it('edits a file', () => {
    expect(say({ kind: 'edit_file', path: 'notes.txt', folder: '/work/site', content: 'a', previous: 'b' })).toBe(
      'Edit notes.txt in site',
    );
  });

  it('uses a generic sentence for a connector tool', () => {
    expect(say({ kind: 'tool', tool: 'post_message', connector: 'Slack' })).toBe('Use the post_message tool from Slack');
    expect(say({ kind: 'tool', tool: 'post_message' })).toBe('Use the post_message tool');
  });

  it('says plainly when the request is marked risky or sensitive', () => {
    expect(say({ kind: 'tool', tool: 'drop_table', connector: 'Postgres', flag: 'risky' })).toBe(
      'Use the drop_table tool from Postgres (marked as risky)',
    );
    expect(say({ kind: 'tool', tool: 'read_inbox', connector: 'Mail', flag: 'sensitive' })).toBe(
      'Use the read_inbox tool from Mail (marked as sensitive)',
    );
    expect(say({ kind: 'run_command', program: 'rm', args: ['-rf', 'build'], folder: '/w/ferry', path: '.', flag: 'risky' })).toBe(
      'Run “rm -rf build” in ferry (marked as risky)',
    );
  });

  it('cuts a long command and a long path', () => {
    const long = say({ kind: 'run_command', program: 'node', args: ['x'.repeat(300)], folder: '/w/ferry', path: '.' });
    const command = /“([^”]*)”/.exec(long)?.[1] ?? '';
    expect(command.length).toBe(APPROVAL_COMMAND_MAX_CHARS);
    expect(command.endsWith('…')).toBe(true);

    const file = say({ kind: 'write_file', path: `${'dir/'.repeat(30)}final.txt`, folder: '/w/ferry', content: 'a' });
    expect(file).toContain('…');
    expect(file).toContain('final.txt');
    expect(file.length).toBeLessThan(APPROVAL_NAME_MAX_CHARS + 60);
  });

  it('keeps a multi-line command on one line', () => {
    expect(say({ kind: 'run_command', program: 'echo', args: ['a\nb'], folder: '/w/ferry', path: '.' })).not.toContain('\n');
  });

  it('falls back instead of throwing on missing or odd arguments', () => {
    const generic = 'Do something that needs your approval';
    expect(say({ kind: 'tool' })).toBe(generic);
    expect(say({ kind: 'tool', tool: 42, connector: {} })).toBe(generic);
    expect(say({ kind: 'run_command' })).toBe(generic);
    expect(say({ kind: 'run_command', program: null, args: 'nope' })).toBe(generic);
    expect(say({ kind: 'write_file' })).toBe(generic);
    expect(say({ kind: 'write_file', path: 7 })).toBe(generic);
    expect(say({ kind: 'mystery' } as unknown as ApprovalSubject)).toBe(generic);
    expect(() => describeApproval(null as unknown as ApprovalSubject, t, size)).not.toThrow();
    expect(describeApproval(null as unknown as ApprovalSubject, t, size)).toBe(generic);
  });

  it('ignores non-string arguments and an unknown folder', () => {
    expect(say({ kind: 'run_command', program: 'ls', args: ['a', 3, null, 'b'] })).toBe('Run “ls a b” in the folder');
    expect(say({ kind: 'write_file', path: 'a.txt', content: 'abc' })).toBe('Write a.txt (0.0 KB) in the folder');
    // A write with no readable content is described as an edit rather than guessing a size.
    expect(say({ kind: 'write_file', path: 'a.txt', folder: '/w/x', content: 5 })).toBe('Edit a.txt in x');
  });

  it('falls back when the size formatter throws', () => {
    const boom = () => {
      throw new Error('no');
    };
    expect(describeApproval({ kind: 'write_file', path: 'a', folder: '/w', content: 'x' }, t, boom)).toBe(
      'Do something that needs your approval',
    );
  });

  it('is translated through the catalog', () => {
    const tDe = translateWith({ ...(en as Record<string, string>), ...(de as Record<string, string>) }, 'de');
    expect(describeApproval({ kind: 'edit_file', path: 'a.txt', folder: '/w/site' }, tDe, size)).toBe('a.txt in site bearbeiten');
  });
});

describe('computerApprovalSubject', () => {
  const base: ComputerRequest = { kind: 'run_command', folder: '/w/ferry', path: '.', reason: 'x', program: 'npm', args: ['test'] };

  it('carries a request into the subject, with its risky flag', () => {
    expect(say(computerApprovalSubject(base))).toBe('Run “npm test” in ferry');
    expect(say(computerApprovalSubject({ ...base, risky: true }))).toBe('Run “npm test” in ferry (marked as risky)');
    expect(
      say(computerApprovalSubject({ kind: 'write_file', folder: '/w/ferry', path: 'a.md', content: 'hi', reason: 'x' })),
    ).toBe('Write a.md (0.0 KB) in ferry');
  });
});
