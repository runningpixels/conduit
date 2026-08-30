/**
 * Phase 2 — the brand logo render path. Two boundaries get tested here:
 *
 *   - `isValidLogoDataUri` / `fetchBrandLogo`: the URI Rust hands back is
 *     re-validated on arrival exactly like `applyBrand.ts` re-validates hex
 *     colours, because it still crosses a process boundary even though Rust
 *     already assembled it from magic bytes. A malformed or hostile value
 *     must fall back to "no logo", not partially apply.
 *   - `BrandMark`'s `src` branch (`icons.tsx`): a logo may be an SVG, and an
 *     SVG must reach the DOM only as `<img src="data:image/svg+xml...">`,
 *     never inlined via `dangerouslySetInnerHTML` or a parse-and-reinject
 *     step. `<img>` treats SVG as script-inert by spec; inlining it would
 *     not be. These tests assert the *rendered element type*, which is what
 *     actually enforces that boundary — a comment alone would not catch a
 *     future "just inline it for crisper scaling" regression.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { BrandMark } from '../icons';
import { isValidLogoDataUri, fetchBrandLogo } from './logo';

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const SVG_LOGO = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';

describe('isValidLogoDataUri', () => {
  it('accepts a well-formed PNG data URI', () => {
    expect(isValidLogoDataUri(PNG_1X1)).toBe(true);
  });

  it('accepts a well-formed SVG data URI — SVG is allowed, just never inlined', () => {
    expect(isValidLogoDataUri(SVG_LOGO)).toBe(true);
  });

  it('accepts jpeg and webp, the other two Rust-side-sniffed raster formats', () => {
    expect(isValidLogoDataUri('data:image/jpeg;base64,/9k=')).toBe(true);
    expect(isValidLogoDataUri('data:image/webp;base64,UklGRg==')).toBe(true);
  });

  it('rejects a non-data: scheme outright', () => {
    // The exact escape shape a hostile MIME/URI could otherwise exploit if
    // BrandMark's <img src> ever received it unchecked.
    expect(isValidLogoDataUri('javascript:alert(1)')).toBe(false);
    expect(isValidLogoDataUri('https://evil.example/x.png')).toBe(false);
    expect(isValidLogoDataUri('blob:http://localhost/uuid')).toBe(false);
  });

  it('rejects a data: URI with a MIME outside the allowed image list', () => {
    // Rust only ever emits png/jpeg/webp/svg+xml, but this module doesn't
    // trust that — a wrong-MIME value must be rejected the same as a
    // straightforwardly hostile one.
    expect(isValidLogoDataUri('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')).toBe(false);
    expect(isValidLogoDataUri('data:image/gif;base64,R0lGODlh')).toBe(false);
    expect(isValidLogoDataUri('data:application/octet-stream;base64,AA==')).toBe(false);
  });

  it('rejects a data: URI missing the ;base64 marker or carrying non-base64 payload characters', () => {
    expect(isValidLogoDataUri('data:image/png,notbase64')).toBe(false);
    expect(isValidLogoDataUri('data:image/png;base64,not valid base64!!')).toBe(false);
  });

  it('rejects malformed and non-string input without throwing', () => {
    expect(isValidLogoDataUri('')).toBe(false);
    expect(isValidLogoDataUri(undefined)).toBe(false);
    expect(isValidLogoDataUri(null)).toBe(false);
    expect(isValidLogoDataUri(42)).toBe(false);
    expect(isValidLogoDataUri({ src: PNG_1X1 })).toBe(false);
  });
});

describe('BrandMark — the render-site boundary', () => {
  it('with no src, renders the inline built-in SVG exactly as before (regression guard for Sidebar/ArtifactEmptyState)', () => {
    // Both existing call sites (Sidebar.tsx, ArtifactEmptyState.tsx) call
    // BrandMark with no src today. If a Phase 2 change to BrandMark's
    // default branch ever changed that, this is the test that would fail —
    // not one of the two call sites' own suites, which don't assert on the
    // rendered node shape.
    const { container } = render(<BrandMark />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('with a valid src, renders an <img>, not inline markup', () => {
    const { container } = render(<BrandMark src={PNG_1X1} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(PNG_1X1);
    // The built-in glyph must not also be present — src replaces it, not augments it.
    expect(container.querySelector('svg')).toBeNull();
  });

  it('an SVG logo still renders as <img>, never inlined as markup', () => {
    const { container } = render(<BrandMark src={SVG_LOGO} />);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(SVG_LOGO);
    // The whole point: no inline <svg> node from the logo's own markup, and
    // no dangerouslySetInnerHTML-shaped attribute anywhere in the output.
    expect(container.querySelector('svg')).toBeNull();
    expect(container.innerHTML).not.toContain('<script');
  });

  it('gives the logo <img> an empty alt — decorative next to the adjacent wordmark/heading', () => {
    const { container } = render(<BrandMark src={PNG_1X1} />);
    expect(container.querySelector('img')?.getAttribute('alt')).toBe('');
  });
});

describe('fetchBrandLogo — the IPC boundary', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns a valid URI unchanged', async () => {
    vi.doMock('../ipc/client', () => ({ getBrandLogo: vi.fn(async () => PNG_1X1) }));
    const { fetchBrandLogo: fresh } = await import('./logo');
    expect(await fresh()).toBe(PNG_1X1);
  });

  it('returns null, not the raw value, when the URI fails validation', async () => {
    vi.doMock('../ipc/client', () => ({
      getBrandLogo: vi.fn(async () => 'javascript:alert(1)'),
    }));
    const { fetchBrandLogo: fresh } = await import('./logo');
    expect(await fresh()).toBeNull();
  });

  it('returns null when no logo is configured', async () => {
    vi.doMock('../ipc/client', () => ({ getBrandLogo: vi.fn(async () => null) }));
    const { fetchBrandLogo: fresh } = await import('./logo');
    expect(await fresh()).toBeNull();
  });

  it('degrades to null, without throwing, when get_brand_logo is not registered on the Rust side', async () => {
    // The scenario the task calls out explicitly: this command lands on the
    // Rust side in parallel with this renderer work, so at any point before
    // that lands (or if the invoke bridge itself errors for any reason),
    // this must behave exactly like "no logo" instead of failing the boot
    // sequence that fetches it alongside getBrandConfig/getSettings/etc.
    vi.doMock('../ipc/client', () => ({
      getBrandLogo: vi.fn(async () => {
        throw new Error('command get_brand_logo not found');
      }),
    }));
    const { fetchBrandLogo: fresh } = await import('./logo');
    await expect(fresh()).resolves.toBeNull();
  });
});

describe('the logo is never written to localStorage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('fetchBrandLogo does not touch localStorage at all', async () => {
    vi.doMock('../ipc/client', () => ({ getBrandLogo: vi.fn(async () => PNG_1X1) }));
    const { fetchBrandLogo: fresh } = await import('./logo');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');

    await fresh();

    expect(setItemSpy).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    setItemSpy.mockRestore();
  });

  it('no key in localStorage ever holds a data:image logo payload after a fetch', async () => {
    vi.doMock('../ipc/client', () => ({ getBrandLogo: vi.fn(async () => PNG_1X1) }));
    const { fetchBrandLogo: fresh } = await import('./logo');
    await fresh();

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      expect(localStorage.getItem(key) ?? '').not.toContain('data:image');
    }
  });
});
