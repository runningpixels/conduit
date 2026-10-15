import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComputerRequest, WorkflowAction } from '../ipc/contracts';
import { ActionCard } from './ActionCard';
import { FileDiff } from './FileDiff';
import { diffStats, lineDiff, numberRows } from './lineDiff';

const ipc = vi.hoisted(() => ({ answerWorkflowAction: vi.fn(), getWorkflowRun: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

function action(computer: ComputerRequest, over: Partial<WorkflowAction> = {}): WorkflowAction {
  return {
    runId: 'r1',
    workflowId: 'w1',
    workflowName: 'Site check',
    stepId: 's1',
    connectorId: 'computer',
    connectorName: 'This computer',
    tool: computer.kind,
    description: null,
    arguments:
      computer.kind === 'run_command'
        ? { program: computer.program, args: computer.args, cwd: computer.path }
        : { path: computer.path, content: computer.content },
    inputSchema: {},
    sensitive: false,
    computer,
    requestedAt: '2026-10-12T06:00:00Z',
    expiresAt: '2026-10-13T06:00:00Z',
    ...over,
  };
}

const command: ComputerRequest = {
  kind: 'run_command',
  folder: 'C:\\work\\site',
  program: 'C:\\Program Files\\Git\\cmd\\git.exe',
  args: ['log', '--oneline', '-5'],
  path: '.',
  why: 'See what changed lately',
  reason: 'It is not on your list of commands that run without asking.',
  suggestedRule: 'git log *',
};

const fileChange: ComputerRequest = {
  kind: 'edit_file',
  folder: 'C:\\work\\site',
  path: 'notes.txt',
  content: 'one\ntwo changed\nthree',
  previous: 'one\ntwo\nthree',
  reason: 'This workflow asks before changing files.',
};

function setup(request: ComputerRequest, over: Partial<WorkflowAction> = {}) {
  const onAnswered = vi.fn();
  const a = action(request, over);
  render(<ActionCard action={a} onAnswered={onAnswered} />);
  return { onAnswered, a };
}

beforeEach(() => {
  ipc.answerWorkflowAction.mockReset();
  ipc.answerWorkflowAction.mockResolvedValue(true);
  ipc.getWorkflowRun.mockReset();
  ipc.getWorkflowRun.mockResolvedValue({ run: {}, steps: [] });
});

describe('ActionCard for a command', () => {
  it('leads with the purpose, then the command as one terminal line and the reason chip', () => {
    setup(command);
    expect(screen.getByRole('group', { name: 'See what changed lately' })).toBeInTheDocument();
    expect(screen.getByText(/Site check · step “s1” ·/)).toBeInTheDocument();
    expect(screen.getByLabelText('Command').textContent).toBe('site> git log --oneline -5');
    expect(screen.getByText('git is C:\\Program Files\\Git\\cmd\\git.exe')).toBeInTheDocument();
    expect(screen.getByText('It is not on your list of commands that run without asking.')).toBeInTheDocument();
    expect(screen.queryByText(/It says/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Don’t run' })).toBeInTheDocument();
  });

  it('falls back to the plain title and quotes arguments with spaces', () => {
    setup({ ...command, why: undefined, args: ['commit', '-m', 'a b'], path: 'docs' });
    expect(screen.getByRole('group', { name: 'Check before it runs a command' })).toBeInTheDocument();
    expect(screen.getByLabelText('Command').textContent).toBe('docs> git commit -m "a b"');
  });

  it('says the wording of the deadline', () => {
    setup(command);
    expect(screen.getByText(/^Waits until .*, then counts as Don’t run\.$/)).toBeInTheDocument();
  });

  it('shows one chip for outside content instead of two sentences', () => {
    setup({ ...command, readBefore: '2 web pages' });
    expect(
      screen.getByText('Asking because the agent read outside content first (2 web pages)'),
    ).toBeInTheDocument();
    expect(screen.queryByText(command.reason)).toBeNull();
  });

  it('runs it as shown', async () => {
    const { onAnswered, a } = setup(command);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith(a, true));
    expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: true });
  });

  it('says no', async () => {
    setup(command);
    fireEvent.click(screen.getByRole('button', { name: 'Don’t run' }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: false }));
  });

  it('runs and allows the offered rule with one click', async () => {
    setup(command);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run and allow git log *' }));
    await waitFor(() =>
      expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: true, remember: true, rule: 'git log *' }),
    );
  });

  it('lets the rule be reworded in Edit mode', async () => {
    setup(command);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow this rule from now on' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Rule to remember' }), { target: { value: 'git log --oneline *' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', {
        send: true,
        arguments: { program: 'C:\\Program Files\\Git\\cmd\\git.exe', args: ['log', '--oneline', '-5'], cwd: '.' },
        remember: true,
        rule: 'git log --oneline *',
      }),
    );
  });

  it('does not remember in Edit mode unless ticked', async () => {
    setup(command);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', {
        send: true,
        arguments: { program: 'C:\\Program Files\\Git\\cmd\\git.exe', args: ['log', '--oneline', '-5'], cwd: '.' },
      }),
    );
  });

  it('sends edited arguments, one per line', async () => {
    setup(command);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: /Arguments/ });
    expect(box).toHaveValue('log\n--oneline\n-5');
    fireEvent.change(box, { target: { value: 'log\n-1\n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', {
        send: true,
        arguments: { program: 'C:\\Program Files\\Git\\cmd\\git.exe', args: ['log', '-1'], cwd: '.' },
      }),
    );
  });

  it('offers no rule when it must always ask or none is suggested', () => {
    const { unmount } = render(<ActionCard action={action(command, { sensitive: true })} onAnswered={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Run and allow/ })).toBeNull();
    unmount();
    render(<ActionCard action={action({ ...command, suggestedRule: undefined })} onAnswered={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Run and allow/ })).toBeNull();
  });

  it('shows the backend reason when the answer fails', async () => {
    ipc.answerWorkflowAction.mockRejectedValue({ message: 'Rule does not parse' });
    setup(command);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Rule does not parse');
  });

  it('sums up what already happened in this run, last four at most', async () => {
    const rec = (args: string[], approvedBy: string) => ({
      kind: 'command', program: 'git', args, cwd: '.', approvedBy, outcome: 'ran',
    });
    ipc.getWorkflowRun.mockResolvedValue({
      run: {},
      steps: [
        { output: { computer: [rec(['a'], 'rule: git a'), rec(['b'], 'you'), rec(['c'], 'you')] } },
        { output: { computer: [rec(['status'], 'rule: git status'), { kind: 'write', path: 'price.js', approvedBy: 'you', outcome: 'changed' }] } },
        { output: null },
      ],
    });
    setup(command);
    expect(await screen.findByText(/^So far in this run:/)).toHaveTextContent(
      'So far in this run: git b ran (you approved) · git c ran (you approved) · git status ran (rule) · price.js changed (you approved)',
    );
    expect(screen.getByText(/^So far/).textContent).not.toContain('git a ran');
    expect(ipc.getWorkflowRun).toHaveBeenCalledWith('r1');
  });

  it('shows nothing extra when the run cannot be read', async () => {
    ipc.getWorkflowRun.mockRejectedValue(new Error('gone'));
    setup(command);
    await waitFor(() => expect(ipc.getWorkflowRun).toHaveBeenCalled());
    expect(screen.queryByText(/So far in this run/)).toBeNull();
  });
});

describe('ActionCard for a risky command', () => {
  const risky = { ...command, risky: true, suggestedRule: undefined, reason: 'It deletes files.' };

  it('makes Don’t run the main button and Run anyway a plain one', async () => {
    setup(risky);
    const no = screen.getByRole('button', { name: 'Don’t run' });
    expect(no).toHaveClass('primary');
    const anyway = screen.getByRole('button', { name: 'Run anyway' });
    expect(anyway).not.toHaveClass('primary');
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
    expect(screen.getByRole('group', { name: 'See what changed lately' })).toHaveClass('cc-risky');
    fireEvent.click(no);
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: false }));
  });

  it('runs only when asked to run anyway, never remembering', async () => {
    setup({ ...risky, suggestedRule: 'git log *' });
    expect(screen.queryByRole('button', { name: /Run and allow/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run anyway' }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: true }));
  });
});

describe('ActionCard for a file change', () => {
  it('shows the path, the counts and the change as a line diff', () => {
    setup(fileChange);
    expect(screen.getByRole('group', { name: 'Check before it changes a file' })).toBeInTheDocument();
    expect(screen.getByText('notes.txt')).toBeInTheDocument();
    expect(screen.getByText('+1')).toBeInTheDocument();
    expect(screen.getByText('−1')).toBeInTheDocument();
    const diff = screen.getByRole('group', { name: 'Changes to the file' });
    expect(diff.querySelector('[data-diff="del"]')).toHaveTextContent('two');
    expect(diff.querySelector('[data-diff="add"]')).toHaveTextContent('two changed');
    expect(screen.getByText(/^Waits until .*, then counts as Don’t change\.$/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Don’t change' })).toBeInTheDocument();
  });

  it('badges a new file and shows its content', () => {
    setup({ ...fileChange, kind: 'write_file', previous: undefined, content: 'hello' });
    expect(screen.getByText('New file')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'File content' })).toHaveTextContent('hello');
  });

  it('sends edited content', async () => {
    setup(fileChange);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'File content' }), { target: { value: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change file' }));
    await waitFor(() =>
      expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', {
        send: true,
        arguments: { path: 'notes.txt', content: 'edited' },
      }),
    );
  });

  it('declines', async () => {
    setup(fileChange);
    fireEvent.click(screen.getByRole('button', { name: 'Don’t change' }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: false }));
  });
});

describe('FileDiff', () => {
  it('numbers old and new lines in the gutter', () => {
    const { container } = render(<FileDiff previous={'a\nold\nb'} content={'a\nnew\nb'} />);
    const nos = (kind: string) =>
      Array.from(container.querySelectorAll(`[data-diff="${kind}"] .fd-no`)).map((n) => n.textContent);
    expect(nos('same')).toEqual(['1', '1', '3', '3']);
    expect(nos('del')).toEqual(['2', '']);
    expect(nos('add')).toEqual(['', '2']);
  });

  it('folds a long file behind a toggle', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const { container } = render(<FileDiff path="big.txt" previous={undefined} content={content} />);
    expect(container.querySelectorAll('.fd-line')).toHaveLength(40);
    fireEvent.click(screen.getByRole('button', { name: 'Show all 100 lines' }));
    expect(container.querySelectorAll('.fd-line')).toHaveLength(100);
    expect(screen.getByRole('button', { name: 'Show fewer lines' })).toBeInTheDocument();
  });

  it('says so when nothing changed', () => {
    render(<FileDiff previous="same" content="same" />);
    expect(screen.getByText('The new content is the same as the file now.')).toBeInTheDocument();
  });
});

describe('lineDiff', () => {
  it('marks removed and added lines and folds long unchanged stretches', () => {
    const before = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 6', 'six');
    const rows = lineDiff(before, after);
    expect(rows.filter((r) => r.kind === 'del')).toEqual([{ kind: 'del', text: 'line 6' }]);
    expect(rows.filter((r) => r.kind === 'add')).toEqual([{ kind: 'add', text: 'six' }]);
    expect(rows.filter((r) => r.kind === 'skip')).toEqual([
      { kind: 'skip', count: 4 },
      { kind: 'skip', count: 3 },
    ]);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
    // After the 4-line skip, the next row is old/new line 5.
    expect(numberRows(rows)[1]).toMatchObject({ oldNo: 5, newNo: 5 });
  });

  it('shows the taken-out line before the one replacing it', () => {
    expect(lineDiff('a\nold\nb', 'a\nnew\nb')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' },
      { kind: 'same', text: 'b' },
    ]);
  });

  it('is all additions against an empty file', () => {
    expect(lineDiff('', 'a\nb')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ]);
  });
});
