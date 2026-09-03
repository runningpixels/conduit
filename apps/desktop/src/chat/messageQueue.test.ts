import { describe, expect, it } from 'vitest';
import {
  createQueuedMessage,
  drain,
  enqueue,
  listFor,
  peek,
  previewText,
  remove,
  shift,
  type ConversationQueues,
} from './messageQueue';

describe('messageQueue', () => {
  it('enqueues FIFO per conversation and ignores empty items', () => {
    let queues: ConversationQueues = {};
    queues = enqueue(queues, 'c1', createQueuedMessage('first', undefined, 'a'));
    queues = enqueue(queues, 'c1', createQueuedMessage('second', undefined, 'b'));
    queues = enqueue(queues, 'c2', createQueuedMessage('other', undefined, 'c'));
    queues = enqueue(queues, 'c1', createQueuedMessage('   ', undefined, 'd'));

    expect(listFor(queues, 'c1').map((q) => q.id)).toEqual(['a', 'b']);
    expect(listFor(queues, 'c2').map((q) => q.id)).toEqual(['c']);
    expect(peek(queues, 'c1')?.id).toBe('a');
  });

  it('removes by id and drops empty conversation keys', () => {
    let queues: ConversationQueues = {};
    queues = enqueue(queues, 'c1', createQueuedMessage('one', undefined, 'a'));
    queues = enqueue(queues, 'c1', createQueuedMessage('two', undefined, 'b'));
    queues = remove(queues, 'c1', 'a');
    expect(listFor(queues, 'c1').map((q) => q.id)).toEqual(['b']);
    queues = remove(queues, 'c1', 'b');
    expect(queues).toEqual({});
  });

  it('shifts the head without touching later items', () => {
    let queues: ConversationQueues = {};
    queues = enqueue(queues, 'c1', createQueuedMessage('one', undefined, 'a'));
    queues = enqueue(queues, 'c1', createQueuedMessage('two', undefined, 'b'));
    const shifted = shift(queues, 'c1');
    expect(shifted.item?.id).toBe('a');
    expect(listFor(shifted.queues, 'c1').map((q) => q.id)).toEqual(['b']);
  });

  it('drains all items for a conversation', () => {
    let queues: ConversationQueues = {};
    queues = enqueue(queues, 'c1', createQueuedMessage('one', undefined, 'a'));
    queues = enqueue(queues, 'c1', createQueuedMessage('two', undefined, 'b'));
    queues = enqueue(queues, 'c2', createQueuedMessage('keep', undefined, 'c'));
    const drained = drain(queues, 'c1');
    expect(drained.items.map((q) => q.id)).toEqual(['a', 'b']);
    expect(listFor(drained.queues, 'c1')).toEqual([]);
    expect(listFor(drained.queues, 'c2').map((q) => q.id)).toEqual(['c']);
  });

  it('previewText truncates long messages', () => {
    const item = createQueuedMessage('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP');
    expect(previewText(item, 10)).toBe('abcdefghi…');
    expect(previewText(createQueuedMessage('short'), 48)).toBe('short');
  });
});
