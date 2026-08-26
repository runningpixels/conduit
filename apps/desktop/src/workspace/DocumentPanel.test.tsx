import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BrandConfig } from '@conduit/config-schema';
import type { Artifact, FileState } from '../ipc/contracts';
import { DocumentPanel } from './DocumentPanel';

vi.mock('../ipc/client', () => ({
  getArtifactContentBytes: vi.fn().mockResolvedValue([]),
  readArtifactFileBytes: vi.fn().mockResolvedValue([]),
  revealPath: vi.fn().mockResolvedValue(undefined),
  parseBrandSource: vi.fn().mockRejectedValue(new Error('not a brand')),
  setBrandConfig: vi.fn(),
}));

import { getArtifactContentBytes, readArtifactFileBytes, parseBrandSource, setBrandConfig } from '../ipc/client';

const baseArtifact: Artifact = {
  id: 'a1',
  conversationId: 'c1',
  kind: 'markdown',
  title: 'Note',
  sourceMessageId: 'm1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mimeType: 'text/markdown',
  contentText: '# Hello\n\nworld',
  contentHash: 'h',
  sizeBytes: 14,
};

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

function renderPanel(overrides: Partial<Parameters<typeof DocumentPanel>[0]> = {}) {
  const onSaveContent = vi.fn().mockResolvedValue(undefined);
  const onExport = vi.fn().mockResolvedValue(undefined);
  const onSelectTab = vi.fn();
  const onOpenArtifact = vi.fn();
  render(
    <DocumentPanel
      artifact={baseArtifact}
      openArtifacts={[baseArtifact]}
      fileStateMap={{ a1: 'ok' as FileState }}
      activeFileState="ok"
      allowlist={[]}
      docTab="source"
      onSelectTab={onSelectTab}
      onOpenArtifact={onOpenArtifact}
      onSaveContent={onSaveContent}
      onExport={onExport}
      {...overrides}
    />,
  );
  return { onSaveContent, onExport };
}

function openOverflowMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
}

describe('DocumentPanel Source tab (M3)', () => {
  it('edits inline text and Save overwrites the payload as Text with the existing mimeType', async () => {
    const { onSaveContent } = renderPanel();
    const ta = screen.getByLabelText('Edit Markdown source') as HTMLTextAreaElement;
    expect(ta.value).toBe('# Hello\n\nworld');

    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();

    fireEvent.change(ta, { target: { value: '# Hello\n\nedited world' } });
    await waitFor(() => expect(saveBtn).not.toBeDisabled());
    fireEvent.click(saveBtn);

    await waitFor(() =>
      expect(onSaveContent).toHaveBeenCalledWith('a1', { kind: 'text', text: '# Hello\n\nedited world' }, 'text/markdown'),
    );
  });

  it('does not call Save when the draft is unchanged', async () => {
    const { onSaveContent } = renderPanel();
    const saveBtn = screen.getByRole('button', { name: 'Save' });
    expect(saveBtn).toBeDisabled();
    fireEvent.click(saveBtn);
    expect(onSaveContent).not.toHaveBeenCalled();
  });

  it('Use disk re-saves the on-disk bytes as a File payload with the path filename', async () => {
    const fileArtifact: Artifact = { ...baseArtifact, id: 'a2', contentPath: 'a2/report.txt', mimeType: 'text/plain', contentText: undefined };
    const { onSaveContent } = renderPanel({
      artifact: fileArtifact,
      openArtifacts: [fileArtifact],
      fileStateMap: { a2: 'modified' as FileState },
      activeFileState: 'modified',
    });
    (readArtifactFileBytes as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([10, 20, 30]);

    const useDiskBtn = await screen.findByRole('button', { name: 'Use disk' });
    fireEvent.click(useDiskBtn);
    await waitFor(() =>
      expect(onSaveContent).toHaveBeenCalledWith('a2', { kind: 'file', bytes: [10, 20, 30], filename: 'report.txt' }, 'text/plain'),
    );
  });
});

describe('DocumentPanel Export (M5)', () => {
  it('Save a copy… calls onExport with the artifact id and the metadata pref (default on)', async () => {
    const { onExport } = renderPanel();
    openOverflowMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save a copy…' }));
    await waitFor(() => expect(onExport).toHaveBeenCalledWith('a1', true));
  });

  it('honours the export-metadata pref when off', async () => {
    localStorage.setItem('conduit:v7-export-metadata', 'off');
    try {
      const { onExport } = renderPanel();
      openOverflowMenu();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Save a copy…' }));
      await waitFor(() => expect(onExport).toHaveBeenCalledWith('a1', false));
    } finally {
      localStorage.removeItem('conduit:v7-export-metadata');
    }
  });
});

describe('DocumentPanel V7 chrome', () => {
  it('⋯ menu carries the actions and a metadata block (no details column)', () => {
    renderPanel({ docTab: 'preview' });
    openOverflowMenu();
    expect(screen.getByRole('menuitem', { name: 'Copy contents' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Save a copy…' })).toBeInTheDocument();
    // "Reveal in Explorer" is gone: a text-backed artifact has no file on disk,
    // so the item was permanently disabled. Save a copy… now reveals the export.
    expect(screen.queryByRole('menuitem', { name: /reveal/i })).toBeNull();
    // Metadata block: path label + size · modified row.
    expect(screen.getAllByText('(inline payload)').length).toBeGreaterThan(0);
    expect(screen.getByText(/14 B · modified/)).toBeInTheDocument();
    // The V6 details column is gone.
    expect(screen.queryByRole('button', { name: 'Hide details' })).not.toBeInTheDocument();
    expect(document.querySelector('.doc-details')).toBeNull();
  });

  it('shows a version tail in the metadata block when the sidecar has one', () => {
    const versioned: Artifact = { ...baseArtifact, metadata: { version: 3 } };
    renderPanel({ artifact: versioned, openArtifacts: [versioned], docTab: 'preview' });
    openOverflowMenu();
    expect(screen.getByText('v3')).toBeInTheDocument();
  });

  it('renders the persistent foot strip with path and size · saved', () => {
    renderPanel({ docTab: 'preview' });
    const foot = screen.getByLabelText('Artifact metadata');
    expect(foot).toHaveTextContent('(inline payload)');
    expect(foot).toHaveTextContent(/14 B/);
    expect(foot).toHaveTextContent(/saved/);
  });
});

describe('DocumentPanel chrome', () => {
  it('shows the artifact empty state when no artifact is open', () => {
    render(
      <DocumentPanel
        artifact={null}
        openArtifacts={[]}
        fileStateMap={{}}
        activeFileState="noFileContent"
        allowlist={[]}
        docTab="preview"
        onSelectTab={vi.fn()}
        onOpenArtifact={vi.fn()}
        onSaveContent={vi.fn()}
        onExport={vi.fn()}
      />,
    );
    expect(screen.getByText('Artifacts live here')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More actions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  // The empty panel renders no toolbar at all. The bar it used to show held
  // nothing but a spacer and this button — 44px of blank chrome above a state
  // that already says the panel is empty. Hiding is the top bar's job (and ⌘J).
  it('renders no toolbar or collapse control on the empty state', () => {
    const { container } = render(
      <DocumentPanel
        artifact={null}
        openArtifacts={[]}
        fileStateMap={{}}
        activeFileState="noFileContent"
        allowlist={[]}
        docTab="preview"
        onSelectTab={vi.fn()}
        onOpenArtifact={vi.fn()}
        onSaveContent={vi.fn()}
        onExport={vi.fn()}
        onCollapsePanel={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Hide artifact panel' })).toBeNull();
    expect(container.querySelector('.doc-toolbar')).toBeNull();
    expect(screen.getByText('Artifacts live here')).toBeInTheDocument();
  });

  it('shows a close control when only one artifact is open', () => {
    const onCloseTab = vi.fn();
    renderPanel({ docTab: 'preview', onCloseTab });
    expect(screen.getByText('Note')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Note' }));
    expect(onCloseTab).toHaveBeenCalledWith('a1');
  });

  it('offers Close in the overflow menu for a single open artifact', () => {
    const onCloseTab = vi.fn();
    renderPanel({ docTab: 'preview', onCloseTab });
    openOverflowMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close' }));
    expect(onCloseTab).toHaveBeenCalledWith('a1');
  });

  it('shows a generating placeholder when a create is pending', () => {
    renderPanel({
      artifact: null,
      openArtifacts: [],
      pendingArtifact: {
        kind: 'html',
        title: 'API Overview',
        toolName: 'write_html_document',
        mode: 'create',
      },
      docTab: 'preview',
    });
    expect(screen.getByText(/Generating html document/i)).toBeInTheDocument();
    expect(screen.getByText('API Overview')).toBeInTheDocument();
    expect(screen.queryByText('Artifacts live here')).not.toBeInTheDocument();
  });

  // A turn that dies mid-write leaves this panel as the only surface still
  // claiming to be working. It must stop shimmering and say what happened.
  it('shows the reason instead of a skeleton when the generation failed', () => {
    const onDismissPending = vi.fn();
    renderPanel({
      artifact: null,
      openArtifacts: [],
      pendingArtifact: {
        kind: 'html',
        title: 'Today’s News',
        toolName: 'write_html_document',
        mode: 'create',
        status: 'failed',
        error: 'Agent turn exceeded wall-clock budget (300s).',
      },
      docTab: 'preview',
      onDismissPending,
    });

    expect(screen.getByText(/wall-clock budget/i)).toBeInTheDocument();
    expect(screen.queryByText(/Generating html document/i)).not.toBeInTheDocument();
    expect(document.querySelector('.artifact-skeleton')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissPending).toHaveBeenCalled();
  });

  it('falls back to a generic reason when the failure carried no message', () => {
    renderPanel({
      artifact: null,
      openArtifacts: [],
      pendingArtifact: {
        kind: 'html',
        toolName: 'write_html_document',
        mode: 'create',
        status: 'failed',
      },
      docTab: 'preview',
    });

    expect(screen.getByText(/Generation failed/i)).toBeInTheDocument();
  });

  it('shows an updating banner when an edit is pending on an open artifact', () => {
    renderPanel({
      docTab: 'preview',
      pendingArtifact: {
        kind: 'markdown',
        toolName: 'edit_markdown_document',
        mode: 'edit',
        artifactId: 'a1',
      },
    });
    expect(screen.getByText(/Updating document/i)).toBeInTheDocument();
    expect(screen.getByText('Note')).toBeInTheDocument();
  });

  it('shows artifact tabs when multiple artifacts are open', () => {
    const second: Artifact = { ...baseArtifact, id: 'a2', title: 'Second' };
    renderPanel({ openArtifacts: [baseArtifact, second], docTab: 'preview', onCloseTab: vi.fn() });
    expect(screen.getByRole('button', { name: 'Close Note' })).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('calls onCollapsePanel when the hide button is clicked', () => {
    const onCollapsePanel = vi.fn();
    renderPanel({ onCollapsePanel, docTab: 'preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide artifact panel' }));
    expect(onCollapsePanel).toHaveBeenCalledTimes(1);
  });

  it('calls onCloseTab when a tab close control is clicked', () => {
    const onCloseTab = vi.fn();
    const second: Artifact = { ...baseArtifact, id: 'a2', title: 'Second' };
    renderPanel({ onCloseTab, openArtifacts: [baseArtifact, second], docTab: 'preview' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Note' }));
    expect(onCloseTab).toHaveBeenCalledWith('a1');
  });

  it('uses sibling close buttons without nesting interactive controls in the tab select', () => {
    const second: Artifact = { ...baseArtifact, id: 'a2', title: 'Second' };
    renderPanel({
      openArtifacts: [baseArtifact, second],
      docTab: 'preview',
      onCloseTab: vi.fn(),
      onRenameArtifact: vi.fn(),
    });
    const closeBtn = screen.getByRole('button', { name: 'Close Note' });
    expect(closeBtn.closest('button.tab-select')).toBeNull();
    expect(closeBtn.closest('.artifact-file-tab')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Rename Note' })).toBeInTheDocument();
  });
});

describe('DocumentPanel brand-theme Preview/Apply (white-label plan §4, Phase 4)', () => {
  afterEach(() => {
    vi.mocked(parseBrandSource).mockReset();
    vi.mocked(parseBrandSource).mockRejectedValue(new Error('not a brand'));
    vi.mocked(setBrandConfig).mockReset();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-palette');
  });

  it('shows no branding actions for an ordinary markdown artifact', async () => {
    renderPanel({ artifact: baseArtifact, openArtifacts: [baseArtifact], docTab: 'preview' });
    // Give any (non-existent, for this artifact) parse effect a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(parseBrandSource).not.toHaveBeenCalled();
    expect(screen.queryByText(/defines a brand theme/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('shows nothing when content starts with +++ but parseBrandSource rejects it', async () => {
    vi.mocked(parseBrandSource).mockRejectedValue(new Error('missing required key: identity.appName'));
    renderPanel({
      artifact: BRAND_MARKDOWN_ARTIFACT,
      openArtifacts: [BRAND_MARKDOWN_ARTIFACT],
      fileStateMap: { 'brand-1': 'ok' as FileState },
      activeFileState: 'ok',
      docTab: 'preview',
      brandingEnabled: true,
    });
    await waitFor(() => expect(parseBrandSource).toHaveBeenCalled());
    expect(screen.queryByText(/defines a brand theme/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('shows Preview/Apply actions for a valid brand-theme artifact', async () => {
    vi.mocked(parseBrandSource).mockResolvedValue(VALID_BRAND_CONFIG);
    renderPanel({
      artifact: BRAND_MARKDOWN_ARTIFACT,
      openArtifacts: [BRAND_MARKDOWN_ARTIFACT],
      fileStateMap: { 'brand-1': 'ok' as FileState },
      activeFileState: 'ok',
      docTab: 'preview',
      brandingEnabled: true,
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument());
    expect(parseBrandSource).toHaveBeenCalledWith(BRAND_MARKDOWN_ARTIFACT.contentText);
    expect(screen.getByRole('status', { name: 'Brand theme actions' }).textContent).toMatch(
      /This document defines a brand theme/i,
    );
    expect(screen.getByRole('button', { name: 'Apply…' })).toBeInTheDocument();
  });

  it('shows no branding actions when branding_enabled is off, even for otherwise-valid content', async () => {
    // Content sniffing alone must never be enough -- eligibility also
    // consults `AppSettings.branding_enabled` (threaded in as the
    // `brandingEnabled` prop). Left at the default (`false`) here on
    // purpose: `renderPanel` does not override it.
    vi.mocked(parseBrandSource).mockResolvedValue(VALID_BRAND_CONFIG);
    renderPanel({
      artifact: BRAND_MARKDOWN_ARTIFACT,
      openArtifacts: [BRAND_MARKDOWN_ARTIFACT],
      fileStateMap: { 'brand-1': 'ok' as FileState },
      activeFileState: 'ok',
      docTab: 'preview',
    });
    // Give the (skipped) parse effect a tick to settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(parseBrandSource).not.toHaveBeenCalled();
    expect(screen.queryByText(/defines a brand theme/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });

  it('Preview applies the palette locally without writing the pre-paint localStorage cache', async () => {
    vi.mocked(parseBrandSource).mockResolvedValue(VALID_BRAND_CONFIG);
    renderPanel({
      artifact: BRAND_MARKDOWN_ARTIFACT,
      openArtifacts: [BRAND_MARKDOWN_ARTIFACT],
      fileStateMap: { 'brand-1': 'ok' as FileState },
      activeFileState: 'ok',
      docTab: 'preview',
      effectiveTheme: 'dark',
      brandingEnabled: true,
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument());

    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    // The palette is applied to the live DOM…
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--bg')).toBe(BRAND_PALETTE_DARK.bg),
    );
    expect(document.documentElement.getAttribute('data-palette')).toBe('brand');
    // …but nothing is written to localStorage — an abandoned preview must
    // never resurrect on next launch (applyBrand.ts's pre-paint cache doc
    // comment; BrandingSection.tsx's own live preview makes the same call).
    expect(setItemSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Stop previewing' })).toBeInTheDocument();

    // And the way back out actually clears the applied colour.
    fireEvent.click(screen.getByRole('button', { name: 'Stop previewing' }));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bg')).toBe(''));
  });

  it('Apply requires confirmation before persisting, and applies the re-parsed result', async () => {
    vi.mocked(parseBrandSource).mockResolvedValue(VALID_BRAND_CONFIG);
    vi.mocked(setBrandConfig).mockResolvedValue(VALID_BRAND_CONFIG);
    renderPanel({
      artifact: BRAND_MARKDOWN_ARTIFACT,
      openArtifacts: [BRAND_MARKDOWN_ARTIFACT],
      fileStateMap: { 'brand-1': 'ok' as FileState },
      activeFileState: 'ok',
      docTab: 'preview',
      brandingEnabled: true,
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply…' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Apply…' }));
    // Confirmation dialog shown; nothing persisted yet.
    expect(await screen.findByText('Apply this brand?')).toBeInTheDocument();
    expect(setBrandConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Apply brand' }));
    await waitFor(() => expect(setBrandConfig).toHaveBeenCalledWith(BRAND_MARKDOWN_ARTIFACT.contentText));
  });
});
