import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComputerRequest, WorkflowAction } from '../ipc/contracts';
import { ActionCard } from './ActionCard';
import { lineDiff } from './lineDiff';

const ipc = vi.hoisted(() => ({ answerWorkflowAction: vi.fn() }));
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
  path: 'docs',
  why: 'See what changed lately',
  reason: 'It is not on your list of commands that run without asking.',
  readBefore: '2 web pages and a web search',
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
});

describe('ActionCard for a command', () => {
  it('shows why it asks, what it read first, and the command one argument per line', () => {
    setup(command);
    expect(screen.getByRole('group', { name: 'Check before it runs a command' })).toBeInTheDocument();
    expect(screen.getByText('It is not on your list of commands that run without asking.')).toBeInTheDocument();
    expect(screen.getByText('It read 2 web pages and a web search before asking.')).toBeInTheDocument();
    expect(screen.getByText('It says: See what changed lately')).toBeInTheDocument();
    expect(screen.getByLabelText('Command').textContent).toBe(
      'C:\\Program Files\\Git\\cmd\\git.exe\nlog\n--oneline\n-5',
    );
    expect(screen.getByText('in C:\\work\\site\\docs')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Don’t run' })).toBeInTheDocument();
  });

  it('shows just the folder when it runs there', () => {
    setup({ ...command, path: '.', readBefore: undefined });
    expect(screen.getByText('in C:\\work\\site')).toBeInTheDocument();
    expect(screen.queryByText(/before asking/)).toBeNull();
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

  it('remembers the rule the user edited', async () => {
    setup(command);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow git log * from now on' }));
    const box = screen.getByRole('textbox', { name: 'Rule to remember' });
    expect(box).toHaveValue('git log *');
    fireEvent.change(box, { target: { value: 'git log --oneline *' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() =>
      expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', {
        send: true,
        remember: true,
        rule: 'git log --oneline *',
      }),
    );
  });

  it('does not remember unless ticked, and not when declining', async () => {
    setup(command);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Allow git log * from now on' }));
    fireEvent.click(screen.getByRole('button', { name: 'Don’t run' }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: false }));
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
        arguments: { program: 'C:\\Program Files\\Git\\cmd\\git.exe', args: ['log', '-1'], cwd: 'docs' },
      }),
    );
  });

  it('offers no rule when it must always ask or none is suggested', () => {
    const { unmount } = render(
      <ActionCard action={action({ ...command, readBefore: undefined }, { sensitive: true })} onAnswered={vi.fn()} />,
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('This one always asks first.')).toBeInTheDocument();
    unmount();
    // Asking because of outside content is for this time only, not always.
    const tainted = render(<ActionCard action={action(command, { sensitive: true })} onAnswered={vi.fn()} />);
    expect(screen.queryByText('This one always asks first.')).toBeNull();
    tainted.unmount();
    render(<ActionCard action={action({ ...command, suggestedRule: undefined })} onAnswered={vi.fn()} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('shows the backend reason when the answer fails', async () => {
    ipc.answerWorkflowAction.mockRejectedValue({ message: 'Rule does not parse' });
    setup(command);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Rule does not parse');
  });
});

describe('ActionCard for a file change', () => {
  it('shows the change as a line diff', () => {
    setup(fileChange);
    expect(screen.getByRole('group', { name: 'Check before it changes a file' })).toBeInTheDocument();
    expect(screen.getByText('Change to notes.txt in C:\\work\\site')).toBeInTheDocument();
    const diff = screen.getByRole('group', { name: 'Changes to the file' });
    expect(diff.querySelector('[data-diff="del"]')).toHaveTextContent('two');
    expect(diff.querySelector('[data-diff="add"]')).toHaveTextContent('two changed');
    expect(screen.getByRole('button', { name: 'Change file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Don’t change' })).toBeInTheDocument();
  });

  it('shows just the content for a new file', () => {
    setup({ ...fileChange, kind: 'write_file', previous: undefined, content: 'hello' });
    expect(screen.getByText('New file notes.txt in C:\\work\\site')).toBeInTheDocument();
    expect(screen.getByLabelText('File content').textContent).toBe('hello');
    expect(screen.queryByRole('group', { name: 'Changes to the file' })).toBeNull();
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
