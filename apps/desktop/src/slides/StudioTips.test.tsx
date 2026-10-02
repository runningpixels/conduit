import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { StudioTips, TIPS_STORAGE_KEY } from './StudioTips';

beforeEach(() => window.localStorage.clear());

describe('StudioTips', () => {
  it('shows nothing until it is visible', () => {
    render(<StudioTips visible={false} />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('steps through three tips and remembers the dismissal', () => {
    const { unmount } = render(<StudioTips visible />);
    expect(screen.getByText('Double-click any text on a slide to edit it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Script shows every word of the deck.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('Text you write is yours: the AI keeps it.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(window.localStorage.getItem(TIPS_STORAGE_KEY)).not.toBeNull();
    unmount();
    render(<StudioTips visible />);
    expect(screen.queryByRole('complementary')).toBeNull();
  });
});
