import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PageLlmBanner, PageLlmDialog } from './PageLlmConsent';
import type { PageLlmState } from '../ipc/client';

const CLOUD: PageLlmState = {
  providerId: 'anthropic',
  providerName: 'Anthropic',
  isLocal: false,
  blockedReason: null,
  granted: null,
};

const LOCAL: PageLlmState = {
  providerId: 'lmstudio',
  providerName: 'LM Studio',
  isLocal: true,
  blockedReason: null,
  granted: null,
};

describe('PageLlmBanner', () => {
  it('shows nothing until a call is pending', () => {
    const { container } = render(<PageLlmBanner pending={false} onReview={() => {}} onNotNow={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('offers Review / Not now while a call is held', () => {
    const onReview = vi.fn();
    const onNotNow = vi.fn();
    render(<PageLlmBanner pending onReview={onReview} onNotNow={onNotNow} />);
    expect(screen.getByRole('status').textContent).toContain('AI model');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onReview).toHaveBeenCalled();
    expect(onNotNow).toHaveBeenCalled();
  });
});

describe('PageLlmDialog', () => {
  it('names a cloud provider and says what leaves the device', () => {
    const onDecide = vi.fn();
    render(<PageLlmDialog open title="Weather dashboard" state={CLOUD} onDecide={onDecide} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('Weather dashboard');
    expect(dialog.textContent).toContain('Anthropic');
    expect(dialog.textContent).toContain('What the page writes is sent to Anthropic.');
    expect(dialog.textContent).not.toContain('Runs on this device.');
  });

  it('says a local model runs on this device, naming no network', () => {
    render(<PageLlmDialog open title={null} state={LOCAL} onDecide={() => {}} />);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('LM Studio');
    expect(dialog.textContent).toContain('Runs on this device.');
    expect(dialog.textContent).not.toContain('is sent to');
  });

  it('offers the three decisions', () => {
    const onDecide = vi.fn();
    render(<PageLlmDialog open title={null} state={CLOUD} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));
    expect(onDecide).toHaveBeenLastCalledWith('deny');
    fireEvent.click(screen.getByRole('button', { name: 'Allow this time' }));
    expect(onDecide).toHaveBeenLastCalledWith('session');
    fireEvent.click(screen.getByRole('button', { name: 'Always allow for this page' }));
    expect(onDecide).toHaveBeenLastCalledWith('page');
  });

  it('treats Escape as "Don\'t allow" without letting the panel see it', () => {
    const onDecide = vi.fn();
    const panelEscape = vi.fn();
    document.addEventListener('keydown', panelEscape);
    render(<PageLlmDialog open title={null} state={CLOUD} onDecide={onDecide} />);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    document.removeEventListener('keydown', panelEscape);
    expect(onDecide).toHaveBeenCalledWith('deny');
    expect(panelEscape).not.toHaveBeenCalled();
  });

  it('renders nothing when closed or state is not loaded yet', () => {
    const { container: closed } = render(<PageLlmDialog open={false} title={null} state={CLOUD} onDecide={() => {}} />);
    expect(closed.textContent).toBe('');
    const { container: noState } = render(<PageLlmDialog open title={null} state={null} onDecide={() => {}} />);
    expect(noState.textContent).toBe('');
  });
});
