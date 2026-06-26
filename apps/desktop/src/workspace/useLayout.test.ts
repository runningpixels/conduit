import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDocPanelCollapse, __readStoredDocPanelForTest, __writeStoredDocPanelForTest } from './useLayout';

describe('useDocPanelCollapse', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-doc-panel');
  });

  it('defaults to open and persists collapse to localStorage', () => {
    const { result } = renderHook(() => useDocPanelCollapse());
    expect(result.current.collapsed).toBe(false);
    expect(document.documentElement.getAttribute('data-doc-panel')).toBe('open');

    act(() => result.current.collapse());
    expect(result.current.collapsed).toBe(true);
    expect(document.documentElement.getAttribute('data-doc-panel')).toBe('collapsed');
    expect(__readStoredDocPanelForTest()).toBe('collapsed');

    act(() => result.current.expand());
    expect(result.current.collapsed).toBe(false);
    expect(__readStoredDocPanelForTest()).toBe('open');
  });

  it('restores persisted collapsed mode on mount', () => {
    __writeStoredDocPanelForTest('collapsed');
    const { result } = renderHook(() => useDocPanelCollapse());
    expect(result.current.collapsed).toBe(true);
    expect(document.documentElement.getAttribute('data-doc-panel')).toBe('collapsed');
  });
});
