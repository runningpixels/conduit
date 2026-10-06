import { describe, expect, it } from 'vitest';
import type { AttachmentDelivery } from '../ipc/contracts';
import {
  attachmentChipState,
  deliveryKeyFor,
  deliveryPending,
  turnAttachmentsFromPending,
  type PendingAttachment,
} from './composerTypes';

const KEY = deliveryKeyFor('anthropic', 'claude-sonnet-4');

function item(
  name: string,
  mimeType: string,
  delivery?: AttachmentDelivery,
  over: Partial<PendingAttachment> = {},
): PendingAttachment {
  return {
    localId: `local-${name}`,
    fileName: name,
    mimeType,
    sizeBytes: 10,
    status: 'uploaded',
    attachment: {
      id: `att-${name}`,
      conversationId: 'c',
      path: 'p',
      mimeType,
      sizeBytes: 10,
      retentionState: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      origin: name,
    },
    delivery,
    deliveryKey: KEY,
    ...over,
  };
}

describe('attachmentChipState', () => {
  it('maps each delivery kind to its chip', () => {
    expect(attachmentChipState(item('a.png', 'image/png', { kind: 'image' }), KEY)).toEqual({ kind: 'image' });
    expect(attachmentChipState(item('a.pdf', 'application/pdf', { kind: 'pdf_native' }), KEY)).toEqual({ kind: 'pdf' });
    expect(attachmentChipState(item('a.txt', 'text/plain', { kind: 'text' }), KEY)).toEqual({ kind: 'text' });
    expect(attachmentChipState(item('a.xlsx', 'x/y', { kind: 'unsupported', reason: 'xlsx files' }), KEY)).toEqual({
      kind: 'unsupported',
      reason: 'xlsx files',
    });
  });

  it('is "checking" for an answer that belongs to another model or has not arrived', () => {
    const stale = item('a.pdf', 'application/pdf', { kind: 'text' }, { deliveryKey: 'openai/gpt-4.1' });
    expect(attachmentChipState(stale, KEY)).toEqual({ kind: 'checking' });
    expect(attachmentChipState(item('b.pdf', 'application/pdf', undefined, { deliveryKey: undefined }), KEY)).toEqual({
      kind: 'checking',
    });
  });

  it('after a failed query vouches only for images', () => {
    expect(attachmentChipState(item('a.png', 'image/png'), KEY)).toEqual({ kind: 'image' });
    expect(attachmentChipState(item('a.pdf', 'application/pdf'), KEY)).toEqual({ kind: 'unknown' });
  });
});

describe('deliveryPending', () => {
  it('waits only for uploaded attachments without an answer for this model', () => {
    expect(deliveryPending([item('a.txt', 'text/plain', { kind: 'text' })], KEY)).toBe(false);
    expect(deliveryPending([item('a.txt', 'text/plain', undefined, { deliveryKey: undefined })], KEY)).toBe(true);
    expect(
      deliveryPending([item('a.txt', 'text/plain', undefined, { deliveryKey: undefined, status: 'failed' })], KEY),
    ).toBe(false);
  });
});

describe('turnAttachmentsFromPending', () => {
  it('forwards image, pdf_native and text deliveries, and drops unsupported ones', () => {
    const turn = turnAttachmentsFromPending(
      [
        item('a.png', 'image/png', { kind: 'image' }),
        item('b.pdf', 'application/pdf', { kind: 'pdf_native' }),
        item('c.txt', 'text/plain', { kind: 'text' }),
        item('d.xlsx', 'application/octet-stream', { kind: 'unsupported', reason: 'xlsx files' }),
      ],
      KEY,
    );
    expect(turn.map((a) => a.fileName)).toEqual(['a.png', 'b.pdf', 'c.txt']);
    expect(turn[1]).toEqual({ id: 'att-b.pdf', mimeType: 'application/pdf', fileName: 'b.pdf' });
  });

  it('skips attachments still uploading or failed', () => {
    expect(
      turnAttachmentsFromPending(
        [
          item('a.txt', 'text/plain', { kind: 'text' }, { status: 'uploading' }),
          item('b.txt', 'text/plain', { kind: 'text' }, { status: 'failed' }),
        ],
        KEY,
      ),
    ).toEqual([]);
  });

  it('does not forward a document whose delivery could not be determined', () => {
    expect(turnAttachmentsFromPending([item('a.pdf', 'application/pdf')], KEY)).toEqual([]);
    expect(turnAttachmentsFromPending([item('a.png', 'image/png')], KEY)).toHaveLength(1);
  });

  it('without a key keeps the image-only rule', () => {
    const items = [item('a.png', 'image/png', { kind: 'image' }), item('b.txt', 'text/plain', { kind: 'text' })];
    expect(turnAttachmentsFromPending(items).map((a) => a.fileName)).toEqual(['a.png']);
  });
});
