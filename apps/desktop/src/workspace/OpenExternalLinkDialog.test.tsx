import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { OpenExternalLinkDialog } from './OpenExternalLinkDialog';

describe('OpenExternalLinkDialog', () => {
  it('renders nothing when url is null', () => {
    const { container } = render(
      <OpenExternalLinkDialog url={null} onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it('shows the URL and Cancel calls onCancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <OpenExternalLinkDialog
        url="https://www.bloomberg.com/news/articles/1"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText('Open external link')).toBeTruthy();
    expect(screen.getByDisplayValue('https://www.bloomberg.com/news/articles/1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Open link calls onConfirm', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <OpenExternalLinkDialog
        url="https://apnews.com/article/1"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open link' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
