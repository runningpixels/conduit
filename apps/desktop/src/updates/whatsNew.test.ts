import { describe, it, expect } from 'vitest';
import { changelogAnchor, changelogLink, compareVersions, whatsNewDecision } from './whatsNew';
// @ts-ignore -- repo-root tooling script, plain ESM JS
import { changelogAnchor as releaseScriptAnchor } from '../../../../scripts/release-notes.mjs';

describe('whatsNew', () => {
  it('links to the same changelog entry as the release page', () => {
    for (const v of ['1.0.0-rc.35', '1.0.0', '1.2.3', '2.0.0-beta.1', '0.1.0', 'junk']) {
      expect(changelogAnchor(v)).toBe(releaseScriptAnchor(v));
    }
    expect(changelogLink('1.0.0-rc.35')).toBe('https://conduitllm.com/changelog#v1-rc-35');
  });

  it('orders release candidates by number, and a release after them', () => {
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.35')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-rc.34', '1.0.0-rc.34')).toBe(0);
    expect(compareVersions('1.0.1', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('nope', '1.0.0')).toBeNull();
  });

  it('says it once after an update', () => {
    expect(whatsNewDecision({ current: '1.0.0-rc.35', lastSeen: '1.0.0-rc.34', onboardingCompleted: true })).toEqual({
      show: true,
      record: '1.0.0-rc.35',
    });
    expect(whatsNewDecision({ current: '1.0.0-rc.35', lastSeen: '1.0.0-rc.35', onboardingCompleted: true })).toEqual({
      show: false,
      record: null,
    });
  });

  it('tells a profile from before the setting existed', () => {
    expect(whatsNewDecision({ current: '1.0.0-rc.35', lastSeen: undefined, onboardingCompleted: true }).show).toBe(true);
  });

  it('says nothing on a new install, a downgrade or a dev build', () => {
    expect(whatsNewDecision({ current: '1.0.0-rc.35', lastSeen: undefined, onboardingCompleted: false })).toEqual({
      show: false,
      record: '1.0.0-rc.35',
    });
    expect(whatsNewDecision({ current: '1.0.0-rc.34', lastSeen: '1.0.0-rc.35', onboardingCompleted: true })).toEqual({
      show: false,
      record: '1.0.0-rc.34',
    });
    expect(whatsNewDecision({ current: '0.1.0', lastSeen: '1.0.0-rc.35', onboardingCompleted: true })).toEqual({
      show: false,
      record: null,
    });
  });
});
