import { describe, expect, test } from 'bun:test';
import { memoryAdapter, pubsubMiddleware } from '../../../../src/middleware/pubsub/index.ts';
import { createMiddlewareContext, createStreamContext } from '../../../../src/middleware/runner.ts';
import type { LLMRequest } from '../../../../src/types/llm.ts';
import { AssistantMessage } from '../../../../src/types/messages.ts';
import { textDelta } from '../../../../src/types/stream.ts';
import { createTurn, emptyUsage } from '../../../../src/types/turn.ts';

function createLLMRequest(): LLMRequest {
  return {
    messages: [],
    config: {} as LLMRequest['config'],
  };
}

function flushAsyncCallbacks(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('Pubsub memory contracts', () => {
  test('memory adapter keeps cursor monotonic after clear()', async () => {
    const adapter = memoryAdapter();
    const cursors: number[] = [];

    adapter.subscribe(
      'stream-1',
      (_event, cursor) => {
        cursors.push(cursor ?? -1);
      },
      () => {},
    );

    const firstEvent = textDelta('first');
    await adapter.append('stream-1', firstEvent);
    adapter.publish('stream-1', firstEvent);
    await flushAsyncCallbacks();

    await adapter.clear('stream-1');

    const secondEvent = textDelta('second');
    await adapter.append('stream-1', secondEvent);
    adapter.publish('stream-1', secondEvent);
    await flushAsyncCallbacks();

    expect(cursors).toEqual([0, 1]);
    expect(adapter.getCursorBase('stream-1')).toBe(1);
  });

  test('pubsub middleware finalizes stream on stream end + turn', async () => {
    const adapter = memoryAdapter();
    const middleware = pubsubMiddleware({ adapter, streamId: 'stream-2' });
    const context = createMiddlewareContext('llm', 'mock-model', 'mock-provider', true, createLLMRequest());

    middleware.onStart?.(context);
    expect(await adapter.exists('stream-2')).toBe(true);

    const streamContext = createStreamContext(context.state);
    middleware.onStreamEvent?.(textDelta('hello'), streamContext);
    await flushAsyncCallbacks();
    expect(await adapter.getEvents('stream-2')).toHaveLength(1);

    let completionCount = 0;
    let finalData: unknown;
    adapter.subscribe(
      'stream-2',
      () => {},
      () => {
        completionCount += 1;
      },
      (data) => {
        finalData = data;
      },
    );

    await middleware.onStreamEnd?.(streamContext);
    expect(await adapter.exists('stream-2')).toBe(true);

    const turn = createTurn(
      [new AssistantMessage('done')],
      [],
      emptyUsage(),
      1,
    );
    await middleware.onTurn?.(turn, context);
    await flushAsyncCallbacks();

    expect(completionCount).toBe(1);
    expect(finalData).toBeDefined();
    expect(await adapter.exists('stream-2')).toBe(false);
  });

  test('pubsub middleware clears buffered events on retry', async () => {
    const adapter = memoryAdapter();
    const middleware = pubsubMiddleware({ adapter, streamId: 'stream-3' });
    const context = createMiddlewareContext('llm', 'mock-model', 'mock-provider', true, createLLMRequest());
    const streamContext = createStreamContext(context.state);

    middleware.onStart?.(context);

    middleware.onStreamEvent?.(textDelta('a'), streamContext);
    await flushAsyncCallbacks();
    expect(await adapter.getEvents('stream-3')).toHaveLength(1);

    await middleware.onRetry?.(1, new Error('retry'), context);
    expect(await adapter.getEvents('stream-3')).toHaveLength(0);

    middleware.onStreamEvent?.(textDelta('b'), streamContext);
    await flushAsyncCallbacks();
    expect(await adapter.getEvents('stream-3')).toHaveLength(1);
  });
});
