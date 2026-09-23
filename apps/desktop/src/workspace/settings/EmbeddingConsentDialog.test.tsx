import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmbeddingConsentDialog } from './EmbeddingConsentDialog';

describe('EmbeddingConsentDialog', () => {
  /**
   * The provider has to be named everywhere the dialog mentions it. The title
   * once rendered as the literal "Send document text to {provider}?" because it
   * was the one call that forgot to pass the value — the body lines passed it,
   * so the dialog looked half right. Found by a person, not a test.
   */
  it('names the provider in the title, the accessible label and the body', () => {
    render(
      <EmbeddingConsentDialog visible providerId="openrouter" onAllow={vi.fn()} onDeny={vi.fn()} />,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-label')).toContain('openrouter');
    expect(screen.getByRole('heading').textContent).toContain('openrouter');
    expect(dialog.textContent).not.toContain('{provider}');
  });
});
