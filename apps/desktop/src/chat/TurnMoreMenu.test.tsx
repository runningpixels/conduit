import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TurnMoreMenu } from './TurnMoreMenu';

describe('TurnMoreMenu', () => {
  it('offers Fork and Delete and shows the token usage', () => {
    const onFork = vi.fn();
    const onDelete = vi.fn();
    render(
      <TurnMoreMenu
        messageId="m1"
        text="A reply"
        readable
        onFork={onFork}
        onDelete={onDelete}
        usage={{ inputTokens: 1200, outputTokens: 34 } as never}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const menu = screen.getByRole('menu', { name: 'More actions' });
    expect(menu).toHaveTextContent('in: 1,200 · out: 34');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork' }));
    expect(onFork).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when it has nothing to offer', () => {
    const { container } = render(<TurnMoreMenu messageId="m1" text="" readable={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
