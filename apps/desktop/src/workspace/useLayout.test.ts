import { describe, expect, it, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useDocPanelCollapse,
  useSidebarCollapse,
  __readStoredDocPanelForTest,
  __writeStoredDocPanelForTest,
  __readStoredSidebarForTest,
  __writeStoredSidebarForTest,
} from './useLayout';

describe('useDocPanelCollapse', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-panel');
  });

  it('defaults to open and persists collapse to localStorage', () => {
    const { result } = renderHook(() => useDocPanelCollapse());
    expect(result.current.collapsed).toBe(false);
    expect(document.documentElement.getAttribute('data-panel')).toBe('open');

    act(() => result.current.collapse());
    expect(result.current.collapsed).toBe(true);
    expect(document.documentElement.getAttribute('data-panel')).toBe('closed');
    expect(__readStoredDocPanelForTest()).toBe('closed');

    act(() => result.current.expand());
    expect(result.current.collapsed).toBe(false);
    expect(__readStoredDocPanelForTest()).toBe('open');
  });

  it('restores persisted collapsed mode on mount', () => {
    __writeStoredDocPanelForTest('closed');
    const { result } = renderHook(() => useDocPanelCollapse());
    expect(result.current.collapsed).toBe(true);
    expect(document.documentElement.getAttribute('data-panel')).toBe('closed');
  });

  it('toggle flips between open and closed', () => {
    const { result } = renderHook(() => useDocPanelCollapse());
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
  });
});

describe('useSidebarCollapse', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-sidebar');
  });

  it('defaults to open and persists collapse to localStorage', () => {
    const { result } = renderHook(() => useSidebarCollapse());
    expect(result.current.collapsed).toBe(false);
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('open');

    act(() => result.current.close());
    expect(result.current.collapsed).toBe(true);
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('closed');
    expect(__readStoredSidebarForTest()).toBe('closed');

    act(() => result.current.open());
    expect(result.current.collapsed).toBe(false);
    expect(__readStoredSidebarForTest()).toBe('open');
  });

  it('restores persisted collapsed mode on mount', () => {
    __writeStoredSidebarForTest('closed');
    const { result } = renderHook(() => useSidebarCollapse());
    expect(result.current.collapsed).toBe(true);
    expect(document.documentElement.getAttribute('data-sidebar')).toBe('closed');
  });
});
