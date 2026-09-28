import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ComposerDocumentPicker, documentOptionId } from './ComposerDocumentPicker';

const options = [
  { documentId: 'd1', title: 'notes.md', collectionId: 'c1', collectionName: 'Research' },
  { documentId: 'd2', title: 'inventory.csv', collectionId: 'c2', collectionName: 'Garden' },
];

describe('ComposerDocumentPicker', () => {
  it('shows each option as Title · Collection', () => {
    render(
      <ComposerDocumentPicker id="picker" options={options} activeIndex={0} onHover={vi.fn()} onPick={vi.fn()} />,
    );
    expect(screen.getByRole('option', { name: 'notes.md · Research' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'inventory.csv · Garden' })).toBeInTheDocument();
  });

  it('marks the active option selected', () => {
    render(
      <ComposerDocumentPicker id="picker" options={options} activeIndex={1} onHover={vi.fn()} onPick={vi.fn()} />,
    );
    expect(screen.getByRole('option', { name: /notes\.md/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('option', { name: /inventory\.csv/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('picks an option on mousedown without blurring the field it came from', () => {
    const onPick = vi.fn();
    render(
      <ComposerDocumentPicker id="picker" options={options} activeIndex={0} onHover={vi.fn()} onPick={onPick} />,
    );
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.mouseDown(screen.getByRole('option', { name: /inventory\.csv/ }));
    expect(onPick).toHaveBeenCalledWith(options[1]);
    // preventDefault on mousedown keeps the browser from shifting focus.
    expect(document.activeElement).toBe(input);
  });

  it('hovering an option reports its index', () => {
    const onHover = vi.fn();
    render(
      <ComposerDocumentPicker id="picker" options={options} activeIndex={0} onHover={onHover} onPick={vi.fn()} />,
    );
    fireEvent.mouseEnter(screen.getByRole('option', { name: /inventory\.csv/ }));
    expect(onHover).toHaveBeenCalledWith(1);
  });

  it('shows a no-matches message instead of an empty list', () => {
    render(<ComposerDocumentPicker id="picker" options={[]} activeIndex={0} onHover={vi.fn()} onPick={vi.fn()} />);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('gives every option a stable id documentOptionId can address for aria-activedescendant', () => {
    render(
      <ComposerDocumentPicker id="picker" options={options} activeIndex={0} onHover={vi.fn()} onPick={vi.fn()} />,
    );
    expect(document.getElementById(documentOptionId('d2'))).toHaveTextContent('inventory.csv');
  });
});
