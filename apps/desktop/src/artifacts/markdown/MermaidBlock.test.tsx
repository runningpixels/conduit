import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { MermaidBlock, sizeSvgFromViewBox } from './MermaidBlock';
import { writeLook } from '../../shell/uiPrefs';
import type { ResolvedTokens } from '../../themes/resolvedTokens';

const NEWLINE = String.fromCharCode(10);

const renderFn = vi.fn(async (_id: string, _text: string) => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg" data-testid="mermaid-svg"></svg>',
}));
const initialize = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize,
    render: (id: string, text: string) => renderFn(id, text),
  },
}));

// Defaults reproduce this file's pre-Phase-3 world (no theme registered, so
// `activeRendererTheming` falls through to native) so every existing test
// below is unaffected; only the dedicated "tokens theming" describe block
// overrides these.
const mockActiveRendererTheming = vi.fn((_kind: 'mermaid' | 'iframe'): 'native' | 'tokens' => 'native');
const mockReadResolvedTokens = vi.fn((): ResolvedTokens => ({}));

vi.mock('../../themes/resolvedTokens', () => ({
  activeRendererTheming: (kind: 'mermaid' | 'iframe') => mockActiveRendererTheming(kind),
  readResolvedTokens: () => mockReadResolvedTokens(),
  useThemeRevision: () => 0,
}));

describe('sizeSvgFromViewBox', () => {
  const root = (extra: string) =>
    `<svg id="x" ${extra} viewBox="0 0 135 269" class="flowchart"></svg>`;

  it('replaces mermaid’s percentage width with the viewBox size', () => {
    const out = sizeSvgFromViewBox(root('width="100%" style="max-width: 135px;"'), 1);
    expect(out).toContain('width="135"');
    expect(out).toContain('height="269"');
    expect(out).not.toContain('100%');
    // The inline cap is what width/height now say; leaving it fights the sheet.
    expect(out).not.toContain('max-width');
  });

  it('applies the display scale to viewBox dimensions', () => {
    const out = sizeSvgFromViewBox(root('width="100%"'), 0.85);
    expect(out).toContain('width="114.75"');
    expect(out).toContain('height="228.65"');
  });

  it('leaves an SVG with no viewBox alone', () => {
    const svg = '<svg width="100%"></svg>';
    expect(sizeSvgFromViewBox(svg, 1)).toBe(svg);
  });

  it('leaves a degenerate viewBox alone rather than emitting width="0"', () => {
    const svg = '<svg width="100%" viewBox="0 0 0 0"></svg>';
    expect(sizeSvgFromViewBox(svg, 1)).toBe(svg);
  });

  it('keeps fractional mermaid dimensions', () => {
    const out = sizeSvgFromViewBox(
      '<svg width="100%" viewBox="0.5 -1.25 134.94 269.42"></svg>',
      1,
    );
    expect(out).toContain('width="134.94"');
    expect(out).toContain('height="269.42"');
  });
});

describe('MermaidBlock', () => {
  beforeEach(() => {
    renderFn.mockClear();
    initialize.mockClear();
    renderFn.mockImplementation(async (_id: string, _text: string) => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" data-testid="mermaid-svg"></svg>',
    }));
    mockActiveRendererTheming.mockReset().mockReturnValue('native');
    mockReadResolvedTokens.mockReset().mockReturnValue({});
  });

  it('renders the diagram as a blob image, not inline SVG markup', async () => {
    const { container } = render(<MermaidBlock source={'flowchart TD\nA-->B'} />);
    const img = await waitFor(() => {
      const el = container.querySelector('img.md-mermaid-img');
      expect(el).not.toBeNull();
      return el as HTMLImageElement;
    });
    expect(img.src).toMatch(/^blob:/);
    expect(container.querySelector('svg[data-testid="mermaid-svg"]')).toBeNull();
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict' }),
    );
  });

  it('falls back to source when mermaid throws', async () => {
    renderFn.mockRejectedValueOnce(new Error('parse'));
    const { container } = render(
      <MermaidBlock source={'not a diagram'} fallback={<pre>not a diagram</pre>} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.md-render-error')).not.toBeNull();
    });
    expect(container.textContent).toContain('not a diagram');
    expect(container.querySelector('img.md-mermaid-img')).toBeNull();
  });

  it('never asks mermaid to render a blank fence, and shows nothing for one', () => {
    // The regression: a fence renders the instant its opening delimiter
    // arrives, so mid-stream `source` is ''. `mermaid.render(id, '')` throws
    // "No diagram type detected", and every throw used to leave a node behind.
    const { container } = render(<MermaidBlock source={'   ' + NEWLINE + ' '} />);
    expect(renderFn).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe('');
  });

  it('holds plain source while rendering — no figure chrome until the blob is ready', async () => {
    let resolveRender!: (value: { svg: string }) => void;
    const pending = new Promise<{ svg: string }>((resolve) => {
      resolveRender = resolve;
    });
    renderFn.mockImplementationOnce(() => pending);
    const { container } = render(
      <MermaidBlock source={'flowchart TD' + NEWLINE + 'A-->B'} fallback={<pre>held</pre>} />,
    );
    expect(container.querySelector('.md-mermaid-pending')).not.toBeNull();
    expect(container.querySelector('.md-mermaid-toolbar')).toBeNull();
    expect(container.querySelector('img.md-mermaid-img')).toBeNull();
    resolveRender({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>' });
    await waitFor(() => {
      expect(container.querySelector('img.md-mermaid-img')).not.toBeNull();
    });
    expect(container.querySelector('.md-mermaid-pending')).toBeNull();
  });

  it('calls onReady when the blob is ready, and stays empty while pending', async () => {
    const onReady = vi.fn();
    let resolveRender!: (value: { svg: string }) => void;
    const pending = new Promise<{ svg: string }>((resolve) => {
      resolveRender = resolve;
    });
    renderFn.mockImplementationOnce(() => pending);
    const { container } = render(
      <MermaidBlock source={'flowchart TD' + NEWLINE + 'A-->B'} onReady={onReady} />,
    );
    expect(container.innerHTML).toBe('');
    expect(onReady).not.toHaveBeenCalled();
    resolveRender({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>' });
    await waitFor(() => {
      expect(onReady).toHaveBeenCalled();
      expect(container.querySelector('img.md-mermaid-img')).not.toBeNull();
    });
  });

  it('initializes with error rendering suppressed and labels as SVG text', async () => {
    const { container } = render(<MermaidBlock source={'flowchart TD' + NEWLINE + 'A-->B'} />);
    await waitFor(() => expect(container.querySelector('img.md-mermaid-img')).not.toBeNull());
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ suppressErrorRendering: true, htmlLabels: false }),
    );
  });

  it('leaves nothing behind in document.body when a render throws', async () => {
    // Stand in for a mermaid that draws its error diagram into a temp node and
    // rethrows without removing it — what 11.17.2 does whenever
    // `suppressErrorRendering` is off (mermaid.core.mjs, the `render` catch).
    renderFn.mockImplementationOnce(async (id: string) => {
      const orphan = document.createElement('div');
      orphan.id = `d${id}`;
      orphan.textContent = 'Syntax error in text';
      document.body.appendChild(orphan);
      throw new Error('parse');
    });
    const { container } = render(<MermaidBlock source={'not a diagram'} />);
    await waitFor(() => {
      expect(container.querySelector('.md-render-error')).not.toBeNull();
    });
    expect(document.body.querySelector('[id^="dconduitMmd"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Syntax error in text');
  });

  it('copies source from the toolbar', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(<MermaidBlock source={'flowchart TD\nA-->B'} />);
    await waitFor(() => expect(container.querySelector('img.md-mermaid-img')).not.toBeNull());
    fireEvent.click(container.querySelector('.md-mermaid-copy')!);
    expect(writeText).toHaveBeenCalledWith('flowchart TD\nA-->B');
  });
});

describe('MermaidBlock — tokens theming', () => {
  const FULL_TOKENS: ResolvedTokens = {
    bg: '#000000',
    bgSide: '#0a0a0a',
    card: '#111111',
    cardHi: '#1a1a1a',
    line: '#262626',
    lineHi: '#3a3a3a',
    ink: '#d9d9d9',
    ink2: '#a6a6a6',
    ink3: '#878787',
    fontUi: '"Geist Mono", ui-monospace, monospace',
    fontMono: '"Geist Mono", ui-monospace, monospace',
  };

  beforeEach(() => {
    renderFn.mockClear();
    initialize.mockClear();
    renderFn.mockImplementation(async (_id: string, _text: string) => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" data-testid="mermaid-svg"></svg>',
    }));
    writeLook('terminal');
  });

  it('initializes with theme "base" and themeVariables when tokens theming is active', async () => {
    mockActiveRendererTheming.mockReset().mockReturnValue('tokens');
    mockReadResolvedTokens.mockReset().mockReturnValue(FULL_TOKENS);
    const { container } = render(<MermaidBlock source={'flowchart TD\nA-->B'} />);
    await waitFor(() => expect(container.querySelector('img.md-mermaid-img')).not.toBeNull());
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: 'base',
        themeVariables: expect.objectContaining({
          background: '#000000',
          primaryColor: '#111111',
          primaryTextColor: '#d9d9d9',
          primaryBorderColor: '#3a3a3a',
          lineColor: '#878787',
          secondaryColor: '#1a1a1a',
          tertiaryColor: '#0a0a0a',
          clusterBkg: '#0a0a0a',
          clusterBorder: '#262626',
          edgeLabelBackground: '#000000',
          fontFamily: '"Geist Mono", ui-monospace, monospace',
          fontSize: '12px',
        }),
      }),
    );
    // Never the native init shape once tokens theming wins.
    expect(initialize).not.toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
    expect(initialize).not.toHaveBeenCalledWith(expect.objectContaining({ theme: 'default' }));
  });

  it('falls back to native when a required token is missing', async () => {
    mockActiveRendererTheming.mockReset().mockReturnValue('tokens');
    mockReadResolvedTokens.mockReset().mockReturnValue({ ...FULL_TOKENS, card: undefined });
    const { container } = render(<MermaidBlock source={'flowchart TD\nA-->B'} />);
    await waitFor(() => expect(container.querySelector('img.md-mermaid-img')).not.toBeNull());
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict' }),
    );
    expect(initialize).not.toHaveBeenCalledWith(expect.objectContaining({ theme: 'base' }));
  });
});
