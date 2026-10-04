import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { OutlineSection } from '../ipc/contracts';
import { OutlineEditor } from './OutlineEditor';

const OUTLINE: OutlineSection[] = [
  { heading: 'Why', intent: 'The pain of many repos', targetWords: 300 },
  { heading: 'How', intent: 'The migration', targetWords: 500 },
  { heading: 'Results', intent: 'What changed' },
];

describe('OutlineEditor', () => {
  it('shows every section with its heading, intent and target', () => {
    render(<OutlineEditor sections={OUTLINE} stage="outline" onChange={vi.fn()} onApprove={vi.fn()} />);
    expect(screen.getByLabelText('Section 1 heading')).toHaveValue('Why');
    expect(screen.getByLabelText('What section 2 must say')).toHaveValue('The migration');
    expect(screen.getByLabelText('Target words for section 1')).toHaveValue('300');
    expect(screen.getByLabelText('Target words for section 3')).toHaveValue('');
    expect(screen.getByText('About 800 words in all')).toBeInTheDocument();
  });

  it('commits an edited heading, intent and length on blur', () => {
    const onChange = vi.fn();
    render(<OutlineEditor sections={OUTLINE} stage="outline" onChange={onChange} />);
    const heading = screen.getByLabelText('Section 1 heading');
    fireEvent.change(heading, { target: { value: 'Why we moved' } });
    fireEvent.blur(heading);
    expect(onChange).toHaveBeenLastCalledWith([{ ...OUTLINE[0], heading: 'Why we moved' }, OUTLINE[1], OUTLINE[2]]);
    const words = screen.getByLabelText('Target words for section 3');
    fireEvent.change(words, { target: { value: '400' } });
    fireEvent.blur(words);
    expect(onChange).toHaveBeenLastCalledWith([
      { ...OUTLINE[0], heading: 'Why we moved' },
      OUTLINE[1],
      { ...OUTLINE[2], targetWords: 400 },
    ]);
  });

  it('does not save when nothing changed', () => {
    const onChange = vi.fn();
    render(<OutlineEditor sections={OUTLINE} stage="outline" onChange={onChange} />);
    fireEvent.blur(screen.getByLabelText('Section 2 heading'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reorders and removes sections', () => {
    const onChange = vi.fn();
    render(<OutlineEditor sections={OUTLINE} stage="outline" onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Move section 1 up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move section 1 down' }));
    expect(onChange).toHaveBeenLastCalledWith([OUTLINE[1], OUTLINE[0], OUTLINE[2]]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove section 3' }));
    expect(onChange).toHaveBeenLastCalledWith([OUTLINE[1], OUTLINE[0]]);
  });

  it('adds a section that is saved once it has a heading', () => {
    const onChange = vi.fn();
    render(<OutlineEditor sections={OUTLINE} stage="outline" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add section' }));
    const heading = screen.getByLabelText('Section 4 heading');
    expect(heading).toHaveFocus();
    fireEvent.blur(heading);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(heading, { target: { value: 'What next' } });
    fireEvent.blur(heading);
    expect(onChange).toHaveBeenLastCalledWith([...OUTLINE, { heading: 'What next', intent: '' }]);
  });

  it('approves: saves a pending edit first, then approves', () => {
    const calls: string[] = [];
    const onChange = vi.fn(() => calls.push('change'));
    const onApprove = vi.fn(() => calls.push('approve'));
    render(<OutlineEditor sections={OUTLINE} stage="outline" onChange={onChange} onApprove={onApprove} />);
    fireEvent.change(screen.getByLabelText('Section 2 heading'), { target: { value: 'How we did it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve outline' }));
    expect(calls).toEqual(['change', 'approve']);
    expect(onChange).toHaveBeenLastCalledWith([OUTLINE[0], { ...OUTLINE[1], heading: 'How we did it' }, OUTLINE[2]]);
  });

  it('cannot approve an empty outline or while the assistant is busy', () => {
    const { rerender } = render(<OutlineEditor sections={[]} stage="outline" onChange={vi.fn()} onApprove={vi.fn()} />);
    expect(screen.getByText('No outline yet. Ask in the chat for one, or add sections yourself.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve outline' })).toBeDisabled();
    rerender(<OutlineEditor sections={[]} stage="outline" busy onChange={vi.fn()} onApprove={vi.fn()} />);
    expect(screen.getByText('The AI is drafting an outline from your brief…')).toBeInTheDocument();
    rerender(<OutlineEditor sections={OUTLINE} stage="outline" busy onChange={vi.fn()} onApprove={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve outline' })).toBeDisabled();
  });

  it('has no Approve button once the draft is being written', () => {
    render(<OutlineEditor sections={OUTLINE} stage="draft" variant="dock" onChange={vi.fn()} onApprove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Approve outline' })).toBeNull();
  });

  it('follows an outline the assistant rewrote', () => {
    const { rerender } = render(<OutlineEditor sections={OUTLINE} stage="outline" onChange={vi.fn()} />);
    rerender(
      <OutlineEditor sections={[{ heading: 'Only one', intent: '', targetWords: 900 }]} stage="outline" onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('Section 1 heading')).toHaveValue('Only one');
    expect(screen.queryByLabelText('Section 2 heading')).toBeNull();
  });
});
