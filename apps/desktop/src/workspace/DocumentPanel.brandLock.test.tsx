// White-label authorization (renderer side): a Mode B build with
// `allowUserBranding = false` must never offer Preview/Apply on a
// brand-theme artifact, even when the content is a perfectly valid
// `brand.md` and the user's own "Enable branding" toggle is on. This is a
// SEPARATE test file (not a `describe` block inside `DocumentPanel.test.tsx`)
// because `../brand/buildFlags`'s `allowUserBranding` is a module-level
// constant baked in at import time -- `vi.mock` below must apply before
// `DocumentPanel` (and everything it imports) is first evaluated, and
// vitest hoists `vi.mock` calls per-file, not per-`describe`. See
// `apps/desktop/vite.config.ts`'s `readAllowUserBranding` for why this would
// otherwise always resolve to `true` under vitest regardless of this mock:
// that special-casing is for the *unmocked* default the rest of the test
// suite relies on, not for a test that specifically wants the locked case.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { BrandConfig } from '@conduit/config-schema';
import type { Artifact, FileState } from '../ipc/contracts';

vi.mock('../brand/buildFlags', () => ({ allowUserBranding: false }));

vi.mock('../ipc/client', () => ({
  getArtifactContentBytes: vi.fn().mockResolvedValue([]),
  readArtifactFileBytes: vi.fn().mockResolvedValue([]),
  revealPath: vi.fn().mockResolvedValue(undefined),
  parseBrandSource: vi.fn(),
  setBrandConfig: vi.fn(),
}));

import { DocumentPanel } from './DocumentPanel';
import { parseBrandSource } from '../ipc/client';
import { allowUserBranding } from '../brand/buildFlags';

const BRAND_PALETTE_DARK = {
  bg: '#0F1115',
  bgSide: '#0B0D11',
  card: '#161A21',
  cardHi: '#1D222B',
  line: '#252B36',
  lineSoft: '#20242C',
  lineHi: '#2C3340',
  ink: '#E8EAED',
  ink2: '#A8AEB8',
  ink3: '#6F7681',
  hue: '#E4572E',
  hueText: '#FF8A61',
  hueSolid: '#E4572E',
  onHue: '#FFFFFF',
  ok: '#3FB950',
  warn: '#D29922',
  err: '#F85149',
  link: '#58A6FF',
};

const BRAND_PALETTE_LIGHT = {
  bg: '#FFFFFF',
  bgSide: '#F5F5F5',
  card: '#FFFFFF',
  cardHi: '#F0F0F0',
  line: '#E0E0E0',
  lineSoft: '#EAEAEA',
  lineHi: '#CCCCCC',
  ink: '#111111',
  ink2: '#333333',
  ink3: '#555555',
  hue: '#E4572E',
  hueText: '#B8451F',
  hueSolid: '#E4572E',
  onHue: '#FFFFFF',
  ok: '#2E7D32',
  warn: '#B26A00',
  err: '#C62828',
  link: '#1A56DB',
};

const VALID_BRAND_CONFIG: BrandConfig = {
  schemaVersion: 1,
  identity: { appName: 'Northwind', displayName: 'Northwind AI' },
  palette: { dark: BRAND_PALETTE_DARK, light: BRAND_PALETTE_LIGHT },
};

const BRAND_MARKDOWN_ARTIFACT: Artifact = {
  id: 'brand-1',
  conversationId: 'c1',
  kind: 'markdown',
  title: 'Northwind theme',
  sourceMessageId: 'm1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mimeType: 'text/markdown',
  contentText: '+++\nschemaVersion = 1\n\n[identity]\nappName = "Northwind"\n+++\n\n# Design notes\n',
  contentHash: 'h',
  sizeBytes: 60,
};

describe('DocumentPanel brand-theme actions on a locked (allowUserBranding=false) build', () => {
  afterEach(() => {
    vi.mocked(parseBrandSource).mockReset();
    vi.restoreAllMocks();
  });

  it('the mock actually took effect (sanity check for the assertions below)', () => {
    expect(allowUserBranding).toBe(false);
  });

  it('never offers Preview/Apply, even for valid content with branding_enabled on', async () => {
    vi.mocked(parseBrandSource).mockResolvedValue(VALID_BRAND_CONFIG);
    const onSaveContent = vi.fn().mockResolvedValue(undefined);
    const onExport = vi.fn().mockResolvedValue(undefined);

    render(
      <DocumentPanel
        artifact={BRAND_MARKDOWN_ARTIFACT}
        openArtifacts={[BRAND_MARKDOWN_ARTIFACT]}
        fileStateMap={{ 'brand-1': 'ok' as FileState }}
        activeFileState="ok"
        allowlist={[]}
        docTab="preview"
        onSelectTab={vi.fn()}
        onOpenArtifact={vi.fn()}
        onSaveContent={onSaveContent}
        onExport={onExport}
        brandingEnabled
      />,
    );

    // Give the (skipped) parse effect a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
    // The build lock short-circuits eligibility before `parseBrandSource` is
    // ever called at all -- there is no point probing whether an artifact
    // *could* be applied when this build can never apply anything.
    expect(parseBrandSource).not.toHaveBeenCalled();
    expect(screen.queryByText(/defines a brand theme/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply…' })).not.toBeInTheDocument();
  });
});
