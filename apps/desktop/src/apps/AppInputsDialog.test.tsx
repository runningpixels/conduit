import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppInput } from '../artifacts/networkHosts';
import { AppInputsDialog } from './AppInputsDialog';

const ipc = vi.hoisted(() => ({
  setAppInputs: vi.fn(),
}));

vi.mock('../ipc/client', () => ipc);

const inputs: AppInput[] = [
  { id: 'city', label: 'City', type: 'string', required: true },
  { id: 'count', label: 'Count', type: 'number', required: false },
  { id: 'notify', label: 'Notify', type: 'boolean', required: false },
  { id: 'units', label: 'Units', type: 'enum', options: ['metric', 'imperial'], required: false },
  { id: 'start', label: 'Start date', type: 'date', required: false },
];

const values = { city: 'Paris', count: 3, notify: true, units: 'metric', start: '2026-01-01' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AppInputsDialog', () => {
  it('renders nothing when appId is null', () => {
    const { container } = render(
      <AppInputsDialog appId={null} inputs={inputs} values={values} onClose={vi.fn()} onSaved={vi.fn()} />,
    );
    expect(container.textContent).toBe('');
  });

  it('renders a control for each input type, seeded with the current values', () => {
    render(<AppInputsDialog appId="a1" inputs={inputs} values={values} onClose={vi.fn()} onSaved={vi.fn()} />);

    expect((screen.getByLabelText('City Required') as HTMLInputElement).value).toBe('Paris');
    expect((screen.getByLabelText('Count') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Notify') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Units') as HTMLSelectElement).value).toBe('metric');
    expect((screen.getByLabelText('Start date') as HTMLInputElement).value).toBe('2026-01-01');
  });

  it('Save sends the edited values to setAppInputs and reports what it returns', async () => {
    ipc.setAppInputs.mockResolvedValue({ ...values, city: 'Berlin' });
    const onSaved = vi.fn();
    render(<AppInputsDialog appId="a1" inputs={inputs} values={values} onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText('City Required'), { target: { value: 'Berlin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(ipc.setAppInputs).toHaveBeenCalledWith('a1', { ...values, city: 'Berlin' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...values, city: 'Berlin' }));
  });

  it('blocks saving and marks a required field left empty, without calling setAppInputs', () => {
    render(<AppInputsDialog appId="a1" inputs={inputs} values={values} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('City Required'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('This is required.')).toBeTruthy();
    expect(ipc.setAppInputs).not.toHaveBeenCalled();
  });

  it('shows a Rust "invalid: …" rejection inline and keeps the dialog open', async () => {
    ipc.setAppInputs.mockRejectedValue(new Error('invalid: units must be metric or imperial'));
    const onSaved = vi.fn();
    render(<AppInputsDialog appId="a1" inputs={inputs} values={values} onClose={vi.fn()} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('alert')).textContent).toContain('invalid: units must be metric or imperial');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('closes on Escape before the document panel sees it', () => {
    const onClose = vi.fn();
    const panelEscape = vi.fn();
    document.addEventListener('keydown', panelEscape);
    render(<AppInputsDialog appId="a1" inputs={inputs} values={values} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(panelEscape).not.toHaveBeenCalled();
    document.removeEventListener('keydown', panelEscape);
  });

  it('cancels without calling setAppInputs', () => {
    const onClose = vi.fn();
    render(<AppInputsDialog appId="a1" inputs={inputs} values={values} onClose={onClose} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(ipc.setAppInputs).not.toHaveBeenCalled();
  });
});
