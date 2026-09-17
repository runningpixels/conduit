import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Artifact } from '../ipc/contracts';
import { ImageRenderer } from './ImageRenderer';

vi.mock('../ipc/client', () => ({
  getArtifactContentBytes: vi.fn(),
}));

import { getArtifactContentBytes } from '../ipc/client';

const mockGetBytes = vi.mocked(getArtifactContentBytes);

function art(over: Partial<Artifact> = {}): Artifact {
  return {
    id: 'img-1',
    conversationId: 'c1',
    kind: 'image',
    title: 'Generated image',
    createdAt: '2026-06-22T00:00:00Z',
    mimeType: 'image/png',
    contentPath: 'blobs/img-1.png',
    ...over,
  };
}

describe('ImageRenderer', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetBytes.mockReset();
    createObjectURL = vi.fn(() => 'blob:mock-url-1');
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  });

  afterEach(() => {
    cleanup();
  });

  it('shows a loading state, then the image once bytes resolve', async () => {
    let resolveBytes: (bytes: number[]) => void;
    mockGetBytes.mockReturnValue(
      new Promise((resolve) => {
        resolveBytes = resolve;
      }),
    );

    const { container } = render(<ImageRenderer artifact={art()} />);

    // Loading: a skeleton, no <img> yet.
    expect(container.querySelector('.artifact-skeleton')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();

    resolveBytes!([137, 80, 78, 71]);

    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    const img = container.querySelector('img') as HTMLImageElement;
    expect(img.src).toBe('blob:mock-url-1');
    expect(img.alt).toBe('Generated image');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it('falls back to image/png when the artifact has no mimeType', async () => {
    mockGetBytes.mockResolvedValue([1, 2, 3]);
    render(<ImageRenderer artifact={art({ mimeType: undefined })} />);
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/png');
  });

  it('shows the readable Rust error for an oversized payload instead of a broken-image icon', async () => {
    mockGetBytes.mockRejectedValue(
      new Error('Artifact payload too large for inline preview (6291456 > 5242880 bytes); use Export'),
    );

    const { container } = render(<ImageRenderer artifact={art()} />);

    await waitFor(() =>
      expect(screen.getByText(/too large for inline preview/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/use Export/i)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('revokes the blob URL on unmount', async () => {
    mockGetBytes.mockResolvedValue([1, 2, 3]);
    const { container, unmount } = render(<ImageRenderer artifact={art()} />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    expect(revokeObjectURL).not.toHaveBeenCalled();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url-1');
  });

  it('revokes the previous blob URL when the artifact changes', async () => {
    mockGetBytes.mockResolvedValueOnce([1]).mockResolvedValueOnce([2]);
    createObjectURL.mockReturnValueOnce('blob:mock-url-1').mockReturnValueOnce('blob:mock-url-2');

    const { container, rerender } = render(<ImageRenderer artifact={art({ id: 'img-1' })} />);
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());

    rerender(<ImageRenderer artifact={art({ id: 'img-2' })} />);
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url-1'));
  });
});
