import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatProse } from './ChatProse';

describe('ChatProse inline rendering', () => {
  it('renders labeled fences as inline source blocks instead of collapsed artifact summaries', () => {
    const src = 'Use this command:\n```bash\nrm -r directory_name\n```';
    const { container } = render(<ChatProse content={src} />);

    expect(container.textContent).toContain('rm -r directory_name');
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.queryByText(/artifact ·/i)).toBeNull();
    expect(document.querySelector('details.artifact-fence-block')).toBeNull();
    expect(document.querySelector('.inline-code-block')).not.toBeNull();
  });

  it('shows copy and promote actions on inline blocks when messageId is provided', () => {
    const src = '```rust\nfn main() {}\n```';
    const onPromote = vi.fn();
    render(
      <ChatProse
        content={src}
        messageId="msg-1"
        onPromoteArtifact={onPromote}
      />,
    );

    expect(screen.getByRole('button', { name: /Copy code/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open as artifact/i })).toBeInTheDocument();
  });

  it('hides promote action while streaming', () => {
    const src = '```python\nprint("hi")\n```';
    render(
      <ChatProse
        content={src}
        streaming
        messageId="msg-1"
        onPromoteArtifact={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Open as artifact/i })).toBeNull();
  });

  it('still renders small unlabeled fences through markdown pre', () => {
    const src = 'Text before.\n```\nlet x=1\n```\nAfter.';
    const { container } = render(<ChatProse content={src} />);

    expect(container.textContent).toContain('let x=1');
    expect(document.querySelector('.inline-code-block')).toBeNull();
    expect(document.querySelector('.md-pre')).not.toBeNull();
  });

  it('syntax-highlights labeled python fences with token spans', () => {
    const src = '```python\nprint("hi")\n```';
    const { container } = render(<ChatProse content={src} />);

    expect(container.textContent).toContain('print("hi")');
    expect(document.querySelectorAll('.inline-code-block-body .keyword').length).toBeGreaterThan(0);
  });

  it('falls back to plain text for unsupported fence languages', () => {
    const src = '```funkylang\nlet x = 1\n```';
    const { container } = render(<ChatProse content={src} />);

    expect(container.textContent).toContain('let x = 1');
    expect(document.querySelectorAll('.inline-code-block-body .keyword').length).toBe(0);
  });
});