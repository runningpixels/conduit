import { describe, it, expect } from 'vitest';
// Repo-root tooling script, plain ESM JS like generate-update-manifest.mjs.
// @ts-ignore
import { changelogAnchor, changelogLink, changelogSection, releaseBody } from '../../../../scripts/release-notes.mjs';

const CHANGELOG = [
  '# Changelog',
  '',
  '## [Unreleased]',
  '',
  '## [1.0.0-rc.35] - 2026-11-18',
  '',
  'A workflow can keep its own browser pace again.',
  '',
  '### Fixed',
  '- Saving a workflow with its own pace (#351)',
  '',
  '## [1.0.0-rc.34] - 2026-11-17',
  '',
  '### Changed',
  '- Human pace (#346)',
  '',
  '[1.0.0-rc.34]: https://example.com/rc34',
].join('\r\n');

describe('release-notes', () => {
  it('gives the ids the site changelog uses', () => {
    expect(changelogAnchor('1.0.0-rc.34')).toBe('v1-rc-34');
    expect(changelogAnchor('1.2.0')).toBe('v1-2-0');
    expect(changelogAnchor('0.0.0-dev')).toBe('v0-dev');
    expect(changelogAnchor('nightly')).toBeNull();
    expect(changelogLink('1.0.0-rc.35')).toBe('https://conduitllm.com/changelog#v1-rc-35');
    expect(changelogLink('nightly')).toBe('https://conduitllm.com/changelog');
  });

  it('takes one release section and nothing past it', () => {
    const section = changelogSection(CHANGELOG, '1.0.0-rc.35');
    expect(section).toBe(
      'A workflow can keep its own browser pace again.\n\n### Fixed\n- Saving a workflow with its own pace (#351)',
    );
    expect(changelogSection(CHANGELOG, '1.0.0-rc.34')).toBe('### Changed\n- Human pace (#346)');
    expect(changelogSection(CHANGELOG, '1.0.0-rc.36')).toBeNull();
    expect(changelogSection(CHANGELOG, 'Unreleased')).toBeNull();
  });

  it('never leaves the release text without notes or the link', () => {
    const body = releaseBody(CHANGELOG, '1.0.0-rc.35');
    expect(body.startsWith('A workflow can keep its own browser pace again.')).toBe(true);
    expect(body).toContain('https://conduitllm.com/changelog#v1-rc-35');
    expect(body).toContain('updater payloads are signature-verified');
    const bare = releaseBody('', '0.0.0-dev');
    expect(bare).toContain('https://conduitllm.com/changelog#v0-dev');
    expect(bare).not.toContain('undefined');
  });
});
