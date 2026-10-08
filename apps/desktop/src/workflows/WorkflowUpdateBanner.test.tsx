import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { WorkflowUpdateBanner } from './WorkflowUpdateBanner';

describe('WorkflowUpdateBanner', () => {
  it('says which workflow updated the document and offers a reload', () => {
    const onReload = vi.fn();
    render(<WorkflowUpdateBanner workflow="Weekly numbers" onReload={onReload} />);
    expect(screen.getByRole('status')).toHaveTextContent('Updated by Weekly numbers');
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
