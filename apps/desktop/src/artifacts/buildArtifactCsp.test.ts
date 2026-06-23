import { describe, expect, it } from 'vitest';
import { buildArtifactCsp, validateAllowedOrigin, OFFLINE_ARTIFACT_CSP } from './buildArtifactCsp';
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