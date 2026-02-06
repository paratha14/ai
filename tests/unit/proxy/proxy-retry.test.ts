/**
 * @fileoverview Unit tests for proxy retry behavior.
 *
 * Tests cover retry mechanics for the stream path through the proxy handler.
 * Streaming retries happen at the executeStream level: doStreamFetch returns
 * a non-ok response, the proxy handler throws via normalizeHttpError, and
 * executeStream catches and retries.
 *
 * Generate retries are handled internally by doFetch - those are covered
 * by proxy-config.test.ts integration tests.
 */
import { test, expect, describe, spyOn } from 'bun:test';
import { llm } from '../../../src/index.ts';
import {
  exponentialBackoff,
  linearBackoff,
  noRetry,
} from '../../../src/http/index.ts';
import * as fetchModule from '../../../src/http/fetch.ts';
import { proxy } from '../../../src/proxy/index.ts';
import { StreamEventType } from '../../../src/types/stream.ts';
import type { StreamEvent } from '../../../src/types/stream.ts';
import { parsedObjectMiddleware } from '../../../src/middleware/parsed-object.ts';
import { UPPError } from '../../../src/types/errors.ts';
import type { Middleware, MiddlewareContext } from '../../../src/types/middleware.ts';

const mockTurnJSON = {
  messages: [
    {
      id: 'msg_1',
      type: 'user',
      content: [{ type: 'text', text: 'Hello' }],
      timestamp: new Date().toISOString(),
    },
    {
      id: 'msg_2',
      type: 'assistant',
      content: [{ type: 'text', text: 'Success after retry' }],
      timestamp: new Date().toISOString(),
    },
  ],
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0 },
  cycles: 1,
  toolExecutions: [],
};

function createSSEResponse(): Response {
  const sseData = [
    'data: {"type":"text_delta","index":0,"delta":{"text":"Success "}}\n\n',
    'data: {"type":"text_delta","index":0,"delta":{"text":"after "}}\n\n',
    'data: {"type":"text_delta","index":0,"delta":{"text":"retry"}}\n\n',
    `data: ${JSON.stringify(mockTurnJSON)}\n\n`,
    'data: [DONE]\n\n',
  ].join('');

  return new Response(sseData, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function createErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    statusText: status === 503 ? 'Service Unavailable' : 'Too Many Requests',
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Proxy Stream Retry', () => {
  test('retries streaming on 503 and succeeds', async () => {
    let callCount = 0;
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return createErrorResponse(503, 'Service Unavailable');
      }
      return createSSEResponse();
    });

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
    });

    const stream = instance.stream('Hello');
    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const turn = await stream.turn;

    expect(turn.response.text).toBe('Success after retry');
    expect(callCount).toBe(2);

    spy.mockRestore();
  });

  test('emits stream_retry event with correct metadata', async () => {
    let callCount = 0;
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return createErrorResponse(503, 'Service Unavailable');
      }
      return createSSEResponse();
    });

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
    });

    const stream = instance.stream('Hello');
    const retryEvents: StreamEvent[] = [];
    for await (const event of stream) {
      if (event.type === StreamEventType.StreamRetry) {
        retryEvents.push(event);
      }
    }

    expect(retryEvents.length).toBe(1);
    expect(retryEvents[0]!.delta.attempt).toBe(1);
    expect(retryEvents[0]!.delta.maxAttempts).toBe(3);
    expect(retryEvents[0]!.delta.error).toBeDefined();
    expect(retryEvents[0]!.delta.error!.code).toBe('PROVIDER_ERROR');
    expect(retryEvents[0]!.delta.timestamp).toBeDefined();

    spy.mockRestore();
  });

  test('emits multiple stream_retry events for multiple failures', async () => {
    let callCount = 0;
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return createErrorResponse(503, 'Service Unavailable');
      }
      return createSSEResponse();
    });

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
    });

    const stream = instance.stream('Hello');
    const retryEvents: StreamEvent[] = [];
    for await (const event of stream) {
      if (event.type === StreamEventType.StreamRetry) {
        retryEvents.push(event);
      }
    }

    expect(retryEvents.length).toBe(2);
    expect(retryEvents[0]!.delta.attempt).toBe(1);
    expect(retryEvents[1]!.delta.attempt).toBe(2);

    spy.mockRestore();
  });

  test('throws when max retry attempts exhausted', async () => {
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      return createErrorResponse(503, 'Service Unavailable');
    });

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 2, baseDelay: 10, jitter: false }),
      },
    });

    const stream = instance.stream('Hello');

    await expect(async () => {
      for await (const event of stream) {
        void event;
      }
    }).toThrow(UPPError);

    spy.mockRestore();
  });

  test('does not retry with noRetry strategy', async () => {
    let callCount = 0;
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      callCount++;
      return createErrorResponse(503, 'Service Unavailable');
    });

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: noRetry(),
      },
    });

    const stream = instance.stream('Hello');

    await expect(async () => {
      for await (const event of stream) {
        void event;
      }
    }).toThrow(UPPError);
    expect(callCount).toBe(1);

    spy.mockRestore();
  });

  test('calls middleware onRetry hook during retry', async () => {
    let callCount = 0;
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return createErrorResponse(503, 'Service Unavailable');
      }
      return createSSEResponse();
    });

    const retryHookCalls: { attempt: number; error: Error }[] = [];
    const middleware: Middleware = {
      name: 'retry-tracker',
      onRetry(attempt: number, error: Error, _ctx: MiddlewareContext) {
        retryHookCalls.push({ attempt, error });
      },
    };

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
      middleware: [middleware],
    });

    const stream = instance.stream('Hello');
    for await (const event of stream) {
      void event;
    }

    expect(retryHookCalls.length).toBe(1);
    expect(retryHookCalls[0]!.attempt).toBe(1);
    expect(retryHookCalls[0]!.error).toBeInstanceOf(UPPError);

    spy.mockRestore();
  });

  test('parsedObjectMiddleware resets state on retry', async () => {
    let callCount = 0;
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return createErrorResponse(503, 'Service Unavailable');
      }
      return createSSEResponse();
    });

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
      middleware: [parsedObjectMiddleware()],
    });

    const stream = instance.stream('Hello');
    const textEvents: StreamEvent[] = [];
    for await (const event of stream) {
      if (event.type === StreamEventType.TextDelta) {
        textEvents.push(event);
      }
    }
    const turn = await stream.turn;

    expect(turn.response.text).toBe('Success after retry');
    expect(textEvents.length).toBe(3);
    expect(callCount).toBe(2);

    spy.mockRestore();
  });

  test('retries with linearBackoff strategy', async () => {
    let callCount = 0;
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return createErrorResponse(503, 'Service Unavailable');
      }
      return createSSEResponse();
    });

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: linearBackoff({ maxAttempts: 3, delay: 10 }),
      },
    });

    const stream = instance.stream('Hello');
    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const turn = await stream.turn;

    expect(turn.response.text).toBe('Success after retry');
    expect(events.some((e) => e.type === StreamEventType.StreamRetry)).toBe(true);
    expect(callCount).toBe(2);

    spy.mockRestore();
  });

  test('does not retry non-retryable 401 errors', async () => {
    let callCount = 0;
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      callCount++;
      return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
    });

    const stream = instance.stream('Hello');

    await expect(async () => {
      for await (const event of stream) {
        void event;
      }
    }).toThrow('Unauthorized');
    expect(callCount).toBe(1);

    spy.mockRestore();
  });

  test('collects text deltas after successful retry', async () => {
    let callCount = 0;
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return createErrorResponse(503, 'Service Unavailable');
      }
      return createSSEResponse();
    });

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
    });

    const stream = instance.stream('Hello');
    const textChunks: string[] = [];
    for await (const event of stream) {
      if (event.type === StreamEventType.TextDelta && event.delta.text) {
        textChunks.push(event.delta.text);
      }
    }

    expect(textChunks).toEqual(['Success ', 'after ', 'retry']);

    spy.mockRestore();
  });

  test('stream can be awaited directly after retry', async () => {
    let callCount = 0;
    const spy = spyOn(fetchModule, 'doStreamFetch').mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        return createErrorResponse(503, 'Service Unavailable');
      }
      return createSSEResponse();
    });

    const proxyProvider = proxy({ endpoint: 'http://localhost:3000' });
    const instance = llm({
      model: proxyProvider('default'),
      config: {
        retryStrategy: exponentialBackoff({ maxAttempts: 3, baseDelay: 10, jitter: false }),
      },
    });

    const turn = await instance.stream('Hello');

    expect(turn.response.text).toBe('Success after retry');
    expect(callCount).toBe(2);

    spy.mockRestore();
  });
});
