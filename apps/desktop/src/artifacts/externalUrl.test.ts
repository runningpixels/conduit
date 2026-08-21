import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_EXTERNAL_LINK_MESSAGE_TYPE,
  artifactExternalLinkGrantKey,
  contentFingerprint,
  isHttpOrHttpsUrl,
  parseArtifactExternalLinkMessage,
} from './externalUrl';

describe('isHttpOrHttpsUrl', () => {
  it('accepts absolute http(s) URLs with path/query/fragment', () => {
    expect(isHttpOrHttpsUrl('https://example.com/a?b=1#c')).toBe(true);
    expect(isHttpOrHttpsUrl('http://localhost:8080/x')).toBe(true);
  });

  it('rejects non-http schemes, userinfo, whitespace, and overlong URLs', () => {
    expect(isHttpOrHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpOrHttpsUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpOrHttpsUrl('mailto:a@b.com')).toBe(false);
    expect(isHttpOrHttpsUrl('data:text/html,x')).toBe(false);
    expect(isHttpOrHttpsUrl('https://user:pass@example.com/x')).toBe(false);
    expect(isHttpOrHttpsUrl('https://a b.com')).toBe(false);
    expect(isHttpOrHttpsUrl('')).toBe(false);
    expect(isHttpOrHttpsUrl(`https://example.com/${'x'.repeat(2100)}`)).toBe(false);
  });
});

describe('parseArtifactExternalLinkMessage', () => {
  it('accepts a well-formed http(s) payload', () => {
    expect(
      parseArtifactExternalLinkMessage({
        type: ARTIFACT_EXTERNAL_LINK_MESSAGE_TYPE,
        href: 'https://apnews.com/article/1',
      }),
    ).toBe('https://apnews.com/article/1');
  });

  it('rejects wrong type, non-http href, and non-objects', () => {
    expect(parseArtifactExternalLinkMessage(null)).toBeNull();
    expect(parseArtifactExternalLinkMessage('x')).toBeNull();
    expect(
      parseArtifactExternalLinkMessage({ type: 'other', href: 'https://example.com' }),
    ).toBeNull();
    expect(
      parseArtifactExternalLinkMessage({
        type: ARTIFACT_EXTERNAL_LINK_MESSAGE_TYPE,
        href: 'javascript:alert(1)',
      }),
    ).toBeNull();
  });
});

describe('artifactExternalLinkGrantKey', () => {
  it('changes when content changes for the same artifact id', () => {
    const a = artifactExternalLinkGrantKey('art-1', '<a href="https://a.test">A</a>');
    const b = artifactExternalLinkGrantKey('art-1', '<a href="https://evil.test">B</a>');
    expect(a).not.toBe(b);
  });

  it('is stable for identical content', () => {
    const content = 'hello';
    expect(artifactExternalLinkGrantKey('x', content)).toBe(
      artifactExternalLinkGrantKey('x', content),
    );
    expect(contentFingerprint(content)).toMatch(/^\d+:[0-9a-z]+$/);
  });

  it('session grant set: approve once, skip later; other artifact or edit re-prompts', () => {
    const grants = new Set<string>();
    const artA = artifactExternalLinkGrantKey('a', 'content-v1');
    const artAEdited = artifactExternalLinkGrantKey('a', 'content-v2');
    const artB = artifactExternalLinkGrantKey('b', 'content-v1');

    // Cancel does not grant.
    expect(grants.has(artA)).toBe(false);

    // Open link grants this artifact+content.
    grants.add(artA);
    expect(grants.has(artA)).toBe(true);
    // Same artifact+content: no prompt.
    expect(grants.has(artA)).toBe(true);
    // Different artifact still prompts.
    expect(grants.has(artB)).toBe(false);
    // Content edit clears the prior grant (new key).
    expect(grants.has(artAEdited)).toBe(false);
  });
});
