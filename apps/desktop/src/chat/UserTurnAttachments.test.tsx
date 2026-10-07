import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../ipc/client', () => ({
  getAttachmentBytes: vi.fn(async () => [1, 2, 3]),
}));

import { UserTurnAttachments, attachmentTypeLabel } from './UserTurnAttachments';

describe('UserTurnAttachments', () => {
  it('renders a PDF as a file chip, not an image', async () => {
    const { container } = render(
      <UserTurnAttachments
        attachments={[{ id: 'a1', mimeType: 'application/pdf', fileName: 'linear-models.pdf' }]}
      />,
    );
    const chip = screen.getByTestId('turn-attachment-file');
    expect(chip.textContent).toContain('linear-models.pdf');
    expect(chip.textContent).toContain('PDF');
    expect(chip.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    const { getAttachmentBytes } = await import('../ipc/client');
    expect(getAttachmentBytes).not.toHaveBeenCalled();
  });

  it('keeps images as thumbnails', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const { container } = render(
      <UserTurnAttachments attachments={[{ id: 'i1', mimeType: 'image/png', fileName: 'p.png' }]} />,
    );
    await waitFor(() => expect(container.querySelector('img.turn-attachment-thumb')).not.toBeNull());
    expect(screen.queryByTestId('turn-attachment-file')).toBeNull();
  });

  it('falls back to a chip when an image fails to load', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const { container } = render(
      <UserTurnAttachments attachments={[{ id: 'i2', mimeType: 'image/png', fileName: 'bad.png' }]} />,
    );
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByTestId('turn-attachment-file').textContent).toContain('bad.png');
    expect(container.querySelector('img')).toBeNull();
  });

  it('derives a type label', () => {
    expect(attachmentTypeLabel({ id: '1', mimeType: 'text/csv', fileName: 'a.csv' })).toBe('CSV');
    expect(attachmentTypeLabel({ id: '1', mimeType: 'text/markdown' })).toBe('MARKDOWN');
  });
});
