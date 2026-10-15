import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { StepComputer, stepComputer } from './StepComputer';

const output = {
  computer: [
    {
      kind: 'command',
      program: 'C:\\Program Files\\Git\\cmd\\git.exe',
      args: ['status', '--short'],
      cwd: '.',
      approvedBy: 'rule: git status',
      outcome: 'ran',
      exitCode: 0,
      durationMs: 1200,
      output: 'M notes.txt',
    },
    {
      kind: 'command',
      program: 'npm',
      args: ['test'],
      cwd: 'app',
      approvedBy: 'you',
      outcome: 'failed',
      exitCode: 1,
      output: Array.from({ length: 30 }, (_, i) => `failing line ${i}`).join('\n'),
      error: 'Exited with 1',
    },
    { kind: 'command', program: 'rm', args: ['-rf', 'x'], cwd: '.', approvedBy: '', outcome: 'declined', reason: 'Always asks' },
    { kind: 'write', path: 'out.txt', approvedBy: "the workflow's edit mode", outcome: 'changed' },
    { kind: 'edit', path: 'notes.txt', approvedBy: 'you', outcome: 'declined' },
    { nonsense: true },
  ],
};

describe('StepComputer', () => {
  it('lists commands and file changes with how they ended and who approved them', () => {
    render(<StepComputer output={output} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(5);
    expect(items[0]).toHaveTextContent('Ran git.exe status --short');
    expect(items[0]).toHaveTextContent('Allowed by the rule git status');
    expect(items[0]).toHaveTextContent('exit code 0');
    expect(items[0]).toHaveTextContent('M notes.txt');
    expect(items[1]).toHaveTextContent('Failed npm test');
    expect(items[1]).toHaveTextContent('You approved it');
    expect(items[1]).toHaveTextContent('in app');
    expect(items[1]).toHaveTextContent('Exited with 1');
    expect(items[2]).toHaveTextContent('Declined rm -rf x');
    expect(items[2]).toHaveTextContent('Always asks');
    expect(items[3]).toHaveTextContent('Changed out.txt');
    expect(items[3]).toHaveTextContent('Allowed by the workflow’s edit mode');
    expect(items[4]).toHaveTextContent('Declined notes.txt');
  });

  it('folds long output and keeps short output in view', () => {
    render(<StepComputer output={output} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0].querySelector('details')).toBeNull();
    const folded = items[1].querySelector('details') as HTMLElement;
    expect(folded).not.toBeNull();
    expect(within(folded).getByText('Output')).toBeInTheDocument();
    expect(folded.hasAttribute('open')).toBe(false);
  });

  it('shows nothing when the step did nothing on the computer', () => {
    const { container } = render(<StepComputer output={{ text: 'hi' }} />);
    expect(container).toBeEmptyDOMElement();
    expect(stepComputer(null)).toEqual([]);
  });
});
