import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXPERIENCED_AT,
  __resetVisitedAreasForTests,
  getVisitedAreas,
  markVisited,
  resolveHomeView,
  setHomeView,
} from './visitedAreas';

beforeEach(() => __resetVisitedAreasForTests());

describe('visited areas', () => {
  it('records each area once, in the app order', () => {
    markVisited('memory');
    markVisited('chats');
    markVisited('memory');
    expect(getVisitedAreas()).toEqual(['chats', 'memory']);
  });

  it('ignores Home, Settings and anything that is not an area', () => {
    markVisited('home');
    markVisited('settings');
    markVisited('ideas');
    markVisited('nonsense');
    expect(getVisitedAreas()).toEqual([]);
  });

  it('keeps the list on this device', () => {
    markVisited('slides');
    expect(JSON.parse(localStorage.getItem('conduit:home-visited-v1') ?? '[]')).toEqual(['slides']);
  });

});

describe('which view Home shows', () => {
  it('guides someone new and goes compact at five areas', () => {
    expect(resolveHomeView(0, null)).toBe('guide');
    expect(resolveHomeView(EXPERIENCED_AT - 1, null)).toBe('guide');
    expect(resolveHomeView(EXPERIENCED_AT, null)).toBe('compact');
  });

  it('lets the reader override either way', () => {
    expect(resolveHomeView(0, 'compact')).toBe('compact');
    expect(resolveHomeView(8, 'guide')).toBe('guide');
  });

  it('remembers the reader’s choice', () => {
    setHomeView('compact');
    expect(localStorage.getItem('conduit:home-view-v1')).toBe('compact');
  });
});
