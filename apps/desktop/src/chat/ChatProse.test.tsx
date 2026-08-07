import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatProse } from './ChatProse';

describe('ChatProse inline rendering', () => {
  it('renders labeled fences as inline source blocks instead of collapsed artifact summaries', () => {
    const src = 'Use this command:\n```bash\nrm -r directory_name\n```';
    const { container } = render(<ChatProse content={src} />);

    expect(container.textContent).toContain('rm -r directory_name');
    expect(screen.getByText('bash')).toBeInTheDocument();
    expect(screen.queryByText(/artifact ·/i)).toBeNull();
    expect(document.querySelector('details.artifact-fence-block')).toBeNull();
    expect(document.querySelector('.inline-code-block')).not.toBeNull();
  });

  it('shows copy and promote actions on inline blocks when messageId is provided', () => {
    // Substantial enough to promote — a fence under MIN_PROMOTABLE_BYTES is a
    // snippet and deliberately offers no promote action (see below).
    const src = `\`\`\`rust\n${'fn main() { println!("hello"); }\n'.repeat(8)}\`\`\``;
    const onPromote = vi.fn();
    render(
      <ChatProse
        content={src}
        messageId="msg-1"
        onPromoteArtifact={onPromote}
      />,
    );

    expect(screen.getByRole('button', { name: /Copy code/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open as artifact/i })).toBeInTheDocument();
  });

  // A one-line command is part of the answer, not a document. Promoting one
  // produced a stored artifact titled `rm -r directory_name` with its own panel
  // tab — 20 bytes of workspace clutter.
  it('offers no promote action on a snippet below the size floor', () => {
    render(
      <ChatProse
        content={'```bash\nrm -r directory_name\n```'}
        messageId="msg-1"
        onPromoteArtifact={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: /Copy code/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open as artifact/i })).toBeNull();
  });

  it('hides promote action while streaming', () => {
    const src = '```python\nprint("hi")\n```';
    render(
      <ChatProse
        content={src}
        streaming
        messageId="msg-1"
        onPromoteArtifact={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: /Open as artifact/i })).toBeNull();
  });

  it('still renders small unlabeled fences through markdown pre', () => {
    const src = 'Text before.\n```\nlet x=1\n```\nAfter.';
    const { container } = render(<ChatProse content={src} />);

    expect(container.textContent).toContain('let x=1');
    expect(document.querySelector('.inline-code-block')).toBeNull();
    expect(document.querySelector('.md-pre')).not.toBeNull();
  });

  // Queried as `.token.keyword`, which is what `syntax.css` actually selects.
  // These assertions used to omit `.token` — and passed, because the component
  // omitted it too. That is precisely how syntax highlighting shipped inert:
  // every rule in syntax.css is `.token.<type>`, so nothing ever matched.
  it('syntax-highlights labeled python fences with token spans', () => {
    const src = '```python\nprint("hi")\n```';
    const { container } = render(<ChatProse content={src} />);

    expect(container.textContent).toContain('print("hi")');
    expect(
      document.querySelectorAll('.inline-code-block-body .token.keyword').length,
    ).toBeGreaterThan(0);
  });

  it('marks a highlighted block as not plain', () => {
    render(<ChatProse content={'```python\nprint("hi")\n```'} />);
    expect(document.querySelector('.inline-code-block[data-plain="true"]')).toBeNull();
  });

  it('marks a text fence as plain so it takes the code colour', () => {
    render(<ChatProse content={'```text\nExpected Return = 13.5%\n```'} />);
    expect(document.querySelector('.inline-code-block[data-plain="true"]')).not.toBeNull();
    expect(document.querySelector('.inline-code-block-body[data-plain="true"]')).not.toBeNull();
  });

  it('falls back to plain text for unsupported fence languages', () => {
    const src = '```funkylang\nlet x = 1\n```';
    const { container } = render(<ChatProse content={src} />);

    expect(container.textContent).toContain('let x = 1');
    expect(document.querySelectorAll('.inline-code-block-body .token.keyword').length).toBe(0);
  });

  it('styles prose links rather than leaving them to the UA', () => {
    const { container } = render(<ChatProse content={'See [the docs](https://example.com).'} />);
    const link = container.querySelector('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://example.com');
    // The rule is `.chat-prose a`, so the anchor must sit inside that scope.
    expect(container.querySelector('.chat-prose a')).not.toBeNull();
  });
});

/**
 * Documents are deliverables you open, not text you read in the transcript, so
 * they collapse to a card. Snippets stay as source — the tests above cover that
 * side and must keep passing.
 */
describe('ChatProse document fences', () => {
  // Sized like a real artifact. The smallest genuine HTML document on record is
  // ~5 KB; anything under MIN_PROMOTABLE_BYTES is treated as a snippet and
  // offers no Open action, so a toy fixture would not exercise this path.
  const html = [
    '<!DOCTYPE html>',
    '<html><head><title>CAPM Demo</title></head>',
    '<body>',
    ...Array.from({ length: 10 }, (_, i) => `  <p class="row-${i}">Expected return row ${i}</p>`),
    '</body></html>',
  ].join('\n');
  const htmlSrc = `Here it is:\n\`\`\`html\n${html}\n\`\`\`\nHope that helps.`;

  it('renders an html fence as a card, not as source', () => {
    const { container } = render(<ChatProse content={htmlSrc} messageId="msg-1" />);

    expect(document.querySelector('.inline-artifact')).not.toBeNull();
    expect(document.querySelector('.inline-code-block')).toBeNull();
    expect(container.textContent).not.toContain('<!DOCTYPE html>');
    // The title comes from the <title> tag via deriveTitle.
    expect(screen.getByText('CAPM Demo')).toBeInTheDocument();
    // Surrounding prose is untouched.
    expect(container.textContent).toContain('Hope that helps.');
  });

  it('reveals the source behind Show code', () => {
    const { container } = render(<ChatProse content={htmlSrc} messageId="msg-1" />);

    expect(container.textContent).not.toContain('<!DOCTYPE html>');
    fireEvent.click(screen.getByRole('button', { name: /Show code/i }));
    expect(container.textContent).toContain('<!DOCTYPE html>');
    expect(screen.getByRole('button', { name: /Hide code/i })).toBeInTheDocument();
  });

  it('keeps source visible while the fence is still streaming', () => {
    // Only the last segment can still be arriving, so the fence has to be last
    // for `streaming` to apply to it.
    const inFlight = `Here it is:\n\`\`\`html\n${html}\n\`\`\``;
    const { container } = render(<ChatProse content={inFlight} streaming messageId="msg-1" />);

    // The inline block is the only place generation is visible, so it must not
    // collapse until the turn completes.
    expect(document.querySelector('.inline-code-block')).not.toBeNull();
    expect(document.querySelector('.inline-artifact')).toBeNull();
    expect(container.textContent).toContain('<!DOCTYPE html>');
  });

  it('collapses a completed fence even while later prose is still streaming', () => {
    // Trailing prose proves the fence closed, so it is no longer the live
    // segment and should already read as a card.
    const { container } = render(<ChatProse content={htmlSrc} streaming messageId="msg-1" />);

    expect(document.querySelector('.inline-artifact')).not.toBeNull();
    expect(container.textContent).not.toContain('<!DOCTYPE html>');
  });

  it('collapses a long code fence but leaves a short one inline', () => {
    const short = `\`\`\`python\n${'x = 1\n'.repeat(5)}\`\`\``;
    const { unmount } = render(<ChatProse content={short} messageId="msg-1" />);
    expect(document.querySelector('.inline-code-block')).not.toBeNull();
    expect(document.querySelector('.inline-artifact')).toBeNull();
    unmount();

    const long = `\`\`\`python\n${'x = 1\n'.repeat(40)}\`\`\``;
    render(<ChatProse content={long} messageId="msg-1" />);
    expect(document.querySelector('.inline-artifact')).not.toBeNull();
    expect(document.querySelector('.inline-code-block')).toBeNull();
  });

  it('promotes and opens from the card when no artifact exists yet', () => {
    const onPromote = vi.fn();
    render(<ChatProse content={htmlSrc} messageId="msg-1" onPromoteArtifact={onPromote} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(onPromote.mock.calls[0][0]).toBe('msg-1');
    expect(onPromote.mock.calls[0][1].kind).toBe('html');
  });

  it('opens the existing artifact when the fence already produced one', () => {
    const onOpen = vi.fn();
    const onPromote = vi.fn();
    // Title deliberately differs from the fence-derived "CAPM Demo": a
    // tool-created artifact is titled from the tool argument, and the old
    // exact-title match missed this and created a duplicate.
    const artifact = {
      id: 'art-1',
      conversationId: 'c1',
      kind: 'html' as const,
      title: 'Interactive CAPM explainer',
      createdAt: '2026-01-01T00:00:00Z',
      sourceMessageId: 'msg-1',
    };

    render(
      <ChatProse
        content={htmlSrc}
        messageId="msg-1"
        artifacts={[artifact]}
        onPromoteArtifact={onPromote}
        onOpenArtifact={onOpen}
      />,
    );

    expect(screen.getByText('Interactive CAPM explainer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledWith('art-1');
    expect(onPromote).not.toHaveBeenCalled();
  });
});
/**
 * Hosted web search annotates a *range*, and for OpenAI that range is exactly
 * the `([host](url))` link the model wrote. Reproduced from a real reply.
 */
describe('ChatProse citations', () => {
  const bullet1 = '- **Earnings are still driving individual stocks.** Companies that beat expectations were rewarded.';
  const bullet2 = '- **Oil moved higher**, which pressured sentiment in parts of the market.';
  const link1 = ' ([apnews.com](https://apnews.com/article/aaa))';
  const link2 = ' ([apnews.com](https://apnews.com/article/bbb))';
  const content = `Here is the takeaway.\n\n${bullet1}${link1}\n${bullet2}${link2}`;

  const citations = [
    {
      index: 1,
      url: 'https://apnews.com/article/aaa',
      title: 'How major US stock indexes fared',
      startIndex: content.indexOf(link1),
      endIndex: content.indexOf(link1) + link1.length,
    },
    {
      index: 2,
      url: 'https://apnews.com/article/bbb',
      title: 'US stocks edge lower',
      startIndex: content.indexOf(link2),
      endIndex: content.indexOf(link2) + link2.length,
    },
  ];

  function renderCited() {
    return render(<ChatProse content={content} citations={citations} />);
  }

  // The bug: the source was sliced at citation offsets and each slice was block
  // parsed on its own, so the <ul> was closed and reopened around every
  // citation and the cited span rendered as its own paragraph.
  it('keeps a cited list as a single list', () => {
    const { container } = renderCited();
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
  });

  it('places each marker inside its own list item', () => {
    const { container } = renderCited();
    const items = container.querySelectorAll('ul li');
    expect(items[0].querySelector('.cite')?.textContent).toBe('1');
    expect(items[1].querySelector('.cite')?.textContent).toBe('2');
  });

  it('replaces the cited span rather than rendering it as well', () => {
    const { container } = renderCited();
    // The redundant "(apnews.com)" link text is gone from the prose; the marker
    // and the footnote row carry the citation instead.
    expect(container.querySelector('.chat-prose-segment')?.textContent).not.toContain('(apnews.com)');
    expect(container.textContent).toContain('Companies that beat expectations were rewarded.');
  });

  it('still lists the sources beneath the message', () => {
    const { container } = renderCited();
    const sources = container.querySelectorAll('.sources .source');
    expect(sources).toHaveLength(2);
    expect(sources[0].textContent).toContain('How major US stock indexes fared');
  });

  it('leaves uncited markdown untouched', () => {
    const { container } = render(<ChatProse content={content} />);
    expect(container.querySelectorAll('ul')).toHaveLength(1);
    expect(container.querySelectorAll('.cite')).toHaveLength(0);
    // Without annotations the model's own link is all there is, so it stays.
    expect(container.textContent).toContain('apnews.com');
  });
});
