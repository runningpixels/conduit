import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '@conduit/ui';

describe('ConfirmDialog', () => {
  it('closes on Escape without confirming', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        description="This cannot be undone."
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('does not confirm on Enter for destructive actions', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete?"
        description="This cannot be undone."
        confirmLabel="Confirm"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('requires typing the confirm phrase before enabling confirm', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Delete all?"
        description="Wipe history."
        confirmPhrase="delete all"
        confirmPhraseHint={<>Type <kbd>delete all</kbd> to confirm</>}
        confirmPhraseInputLabel="Type delete all to confirm"
        confirmLabel="Delete all"
        cancelLabel="Cancel"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    );

    const confirmBtn = screen.getByRole('button', { name: 'Delete all' });
    expect(confirmBtn).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Type delete all to confirm/i), {
      target: { value: 'delete all' },
    });
    expect(confirmBtn).not.toBeDisabled();
    fireEvent.click(confirmBtn);
    expect(onConfirm).toHaveBeenCalled();
  });
});
