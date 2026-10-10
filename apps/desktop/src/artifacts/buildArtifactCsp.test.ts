import { describe, expect, it } from 'vitest';
import { buildArtifactCsp, validateAllowedOrigin, OFFLINE_ARTIFACT_CSP, FULL_ACCESS_ARTIFACT_CSP } from './buildArtifactCsp';
import { escapeHtml } from './escape';

describe('escapeHtml', () => {
  it('escapes the five significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
  it('leaves safe text untouched', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

describe('validateAllowedOrigin', () => {
  it('accepts an https origin and strips path/query/fragment', () => {
    expect(validateAllowedOrigin('https://fonts.example.com/foo?x=1#bar')).toBe(
      'https://fonts.example.com',
    );
  });
  it('accepts http with a port', () => {
    expect(validateAllowedOrigin('http://localhost:8080')).toBe('http://localhost:8080');
  });
  it('rejects javascript: data: and non-URLs', () => {
    expect(validateAllowedOrigin('javascript:alert(1)')).toBeNull();
    expect(validateAllowedOrigin('data:text/html,<script>')).toBeNull();
    expect(validateAllowedOrigin('not a url')).toBeNull();
    expect(validateAllowedOrigin('')).toBeNull();
    expect(validateAllowedOrigin('   ')).toBeNull();
  });
  it('rejects a bare host with no scheme', () => {
    expect(validateAllowedOrigin('fonts.example.com')).toBeNull();
  });
  it('rejects userinfo (prevents spoofing)', () => {
    expect(validateAllowedOrigin('https://trusted.example@attacker.example')).toBeNull();
    expect(validateAllowedOrigin('https://user:pass@example.com')).toBeNull();
  });
});

describe('buildArtifactCsp', () => {
  it('offline (empty) policy has connect-src none and inline-only scripts', () => {
    const csp = OFFLINE_ARTIFACT_CSP;
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('img-src data: blob:');
    expect(csp).toContain('font-src data: blob:');
    // No remote origin anywhere in the offline policy.
    expect(csp).not.toMatch(/script-src 'unsafe-inline' https?:/);
    expect(csp).not.toContain('fonts.example.com');
  });

  it('always includes base-uri, form-action, navigate-to, frame guards', () => {
    const csp = buildArtifactCsp(['https://fonts.example.com'])!;
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("navigate-to 'none'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('widens passive directives only — never script-src or connect-src', () => {
    const csp = buildArtifactCsp(['https://fonts.example.com'])!;
    // The allowlisted origin appears in the passive resource directives.
    expect(csp).toContain('img-src data: blob: https://fonts.example.com');
    expect(csp).toContain('font-src data: blob: https://fonts.example.com');
    expect(csp).toContain("style-src 'unsafe-inline' https://fonts.example.com");
    // script-src stays inline-only (no remote origin appended).
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).not.toMatch(/script-src 'unsafe-inline' https?:/);
    // connect-src stays 'none' regardless of the allowlist.
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/connect-src 'none' https?:/);
  });

  it('rejects malformed / javascript: / data: origins by returning null', () => {
    expect(buildArtifactCsp(['https://ok.example.com', 'javascript:evil'])).toBeNull();
    expect(buildArtifactCsp(['data:text/html,x'])).toBeNull();
    expect(buildArtifactCsp(['not-a-url'])).toBeNull();
  });

  it('deduplicates equivalent origins', () => {
    const csp = buildArtifactCsp([
      'https://fonts.example.com/a',
      'https://fonts.example.com/b',
    ])!;
    const matches = csp.match(/fonts\.example\.com/g) ?? [];
    // Appears once per passive directive (img, font, style) = 3, not 6.
    expect(matches.length).toBe(3);
  });
});
describe('buildArtifactCsp full web access', () => {
  const directives = (csp: string) =>
    new Map(csp.split('; ').map((part) => {
      const [name, ...values] = part.split(' ');
      return [name, values.join(' ')] as const;
    }));

  it('opens scripts, resources and connections to https only', () => {
    const csp = directives(FULL_ACCESS_ARTIFACT_CSP);
    expect(csp.get('script-src')).toBe("'unsafe-inline' https:");
    expect(csp.get('style-src')).toBe("'unsafe-inline' https: data: blob:");
    expect(csp.get('img-src')).toBe('https: data: blob:');
    expect(csp.get('font-src')).toBe('https: data: blob:');
    expect(csp.get('media-src')).toBe('https: data: blob:');
    expect(csp.get('connect-src')).toBe('https: wss:');
    expect(csp.get('frame-src')).toBe('https:');
    expect(csp.get('worker-src')).toBe('blob:');
    expect(FULL_ACCESS_ARTIFACT_CSP).not.toMatch(/\bhttp:|\bws:|'unsafe-eval'|\*/);
  });

  it('keeps the guards that are not about loading', () => {
    const csp = directives(FULL_ACCESS_ARTIFACT_CSP);
    expect(csp.get('default-src')).toBe("'none'");
    expect(csp.get('base-uri')).toBe("'none'");
    expect(csp.get('form-action')).toBe("'none'");
    expect(csp.get('frame-ancestors')).toBe("'none'");
    expect(csp.get('navigate-to')).toBe("'none'");
  });

  it('keeps allowlisted origins on the passive directives and still rejects a bad entry', () => {
    const csp = buildArtifactCsp(['http://images.lan.example:8080'], 'full')!;
    expect(csp).toContain('img-src https: data: blob: http://images.lan.example:8080');
    expect(csp).not.toMatch(/script-src[^;]*http:\/\//);
    expect(buildArtifactCsp(['javascript:x'], 'full')).toBeNull();
  });

  it('leaves the normal policy exactly as it was', () => {
    expect(buildArtifactCsp([], 'normal')).toBe(OFFLINE_ARTIFACT_CSP);
    expect(OFFLINE_ARTIFACT_CSP).toContain("connect-src 'none'");
    expect(OFFLINE_ARTIFACT_CSP).not.toContain('https:');
  });
});
